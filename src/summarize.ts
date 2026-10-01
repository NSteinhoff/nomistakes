/**
 * Session summary extension - summarize an entire session, all branches
 *
 * Unlike /compact or branch summarization (which operate on the current
 * branch only), this walks the full session tree and summarizes every branch,
 * focusing on user messages and agent text responses. Explicit decision points
 * from the `ask` tool (question, options, chosen answer) are included as
 * [Decision] lines, since those choices often determine which branch was
 * taken. All other tool activity - other tool calls and results, bash
 * executions, thinking, and existing compaction/branch summaries - is excluded.
 *
 * The generated summary is opened in an editor for review in the current
 * session; on accept it seeds a named child session as a custom_message context
 * entry. Like a branch summary, it participates in LLM context without starting
 * a turn: the agent stays idle until the user sends a message. A provenance
 * label marks it as prior-session background being continued.
 *
 * Usage:
 *   /summarize
 */

import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	deriveSessionName,
	editAndSeedChildSession,
	generateWithLoader,
} from "./utils/session";

const SYSTEM_PROMPT = `You are a session summarization assistant. You are given the complete history of a coding-agent session, including every branch that was explored. Only user messages, the agent's text responses, and explicit decision points ("[Decision]:" lines capturing a question, its options, and the chosen answer) are included; other tool activity has been removed.

Produce a summary that lets a fresh agent continue the work. Capture intent and reasoning, not a procedural play-by-play: the problem being solved, the approaches considered and why they were chosen or rejected, the design tensions and how they resolved. When the input contains multiple branches (marked with "## Branch" headers), synthesize how the branches relate as alternative ideas rather than recounting each in isolation. Do not invent tool activity or file changes that are not evident from the conversation.

Start your response with a concise title of at most 60 characters on a line enclosed in <session-title> tags identifying the session's central topic. After that line, output the summary using exactly these Markdown sections, omitting any section that has no content:

## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements and preferences stated by the user]

## Progress
### Done
- [Settled outcomes]

### In Progress
- [Open threads]

### Blocked
- [Unresolved tensions, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Facts, file paths, and identifiers needed to continue]

Keep each section concise. Preserve exact file paths, function names, and error messages. Output the sections directly with no preamble.`;

const TITLE_PATTERN = /^<session-title>(.*?)<\/session-title>\s*/s;

const CONTEXT_CUSTOM_TYPE = "session-summary";

/**
 * One-line provenance label prepended to the summary before it is seeded. Being
 * non-turn context, the summary never auto-starts the agent; this label only
 * tells the agent the text is a prior session being continued, not a fresh
 * instruction. `convertToLlm` adds no prefix of its own for custom messages.
 */
const PROVENANCE_LABEL = "Summary of a previous session being continued:";

type GeneratedSummary = {
	summary: string;
	title: string;
};

type ChildrenMap = ReadonlyMap<string | null, readonly SessionEntry[]>;
type EntryMap = ReadonlyMap<string, SessionEntry>;

type AskDecision = {
	question: string;
	answer: string | null;
	cancelled: boolean;
	options: readonly string[] | undefined;
};

/** Separate the generated title from the summary, with a content fallback. */
function parseGeneratedSummary(value: string): GeneratedSummary {
	const trimmed = value.trim();
	const match = TITLE_PATTERN.exec(trimmed);
	const summary = match ? trimmed.slice(match[0].length).trim() : trimmed;
	const generatedTitle = match?.[1]?.trim();
	return {
		summary,
		title: deriveSessionName(generatedTitle || summary || "Session summary"),
	};
}

/** Defensively narrow an untyped `ask` tool result `details` record. */
function asAskDecision(value: unknown): AskDecision | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.question !== "string") {
		return null;
	}
	if (typeof record.cancelled !== "boolean") {
		return null;
	}
	if (record.answer !== null && typeof record.answer !== "string") {
		return null;
	}
	const options = record.options;
	const validOptions =
		options === undefined ||
		(Array.isArray(options) &&
			options.every((option) => typeof option === "string"));
	if (!validOptions) {
		return null;
	}
	return {
		question: record.question,
		answer: record.answer,
		cancelled: record.cancelled,
		options: options as readonly string[] | undefined,
	};
}

/** Extract plain text from a user or assistant message entry; "" otherwise. */
function extractText(entry: SessionEntry): string {
	if (entry.type !== "message") {
		return "";
	}
	const message = entry.message;
	if (message.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
		const trimmed = text.trim();
		return trimmed ? `[User]: ${trimmed}` : "";
	}
	if (message.role === "assistant") {
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		return text ? `[Assistant]: ${text}` : "";
	}
	if (message.role === "toolResult" && message.toolName === "ask") {
		const decision = asAskDecision(message.details);
		if (!decision || decision.cancelled || decision.answer === null) {
			return "";
		}
		const decisionLines = [`[Decision]: ${decision.question.trim()}`];
		if (decision.options && decision.options.length > 0) {
			decisionLines.push(`  options: ${decision.options.join(" | ")}`);
		}
		decisionLines.push(`  answer: ${decision.answer.trim()}`);
		return decisionLines.join("\n");
	}
	return "";
}

/**
 * Render a chain of entries starting at startId into lines. A chain continues
 * through single-child links and stops at leaves or fork points; each fork
 * child is recursed as a labeled sub-branch. Headers are emitted only when the
 * session contains more than one branch.
 */
function renderSegment(
	startId: string,
	label: string,
	children: ChildrenMap,
	entries: EntryMap,
	multiBranch: boolean,
	lines: string[],
): void {
	const segmentLines: string[] = [];
	let currentId: string = startId;
	for (;;) {
		const entry = entries.get(currentId);
		if (entry === undefined) {
			break;
		}
		const text = extractText(entry);
		if (text) {
			segmentLines.push(text);
		}
		const [first, more] = children.get(currentId) ?? [];
		if (first && !more) {
			currentId = first.id;
			continue;
		}
		break;
	}

	if (segmentLines.length > 0) {
		if (multiBranch) {
			lines.push(`## Branch ${label}`);
		}
		for (const line of segmentLines) {
			lines.push(line);
		}
		lines.push("");
	}

	const forks = children.get(currentId) ?? [];
	if (forks.length > 1) {
		forks.forEach((fork, i) => {
			renderSegment(
				fork.id,
				`${label}.${i + 1}`,
				children,
				entries,
				multiBranch,
				lines,
			);
		});
	}
}

/**
 * Serialize all branches of a session into labeled text, keeping only user and
 * assistant messages. Returns "" when no such messages exist.
 */
function serializeSession(allEntries: readonly SessionEntry[]): string {
	const entries: Map<string, SessionEntry> = new Map();
	for (const entry of allEntries) {
		entries.set(entry.id, entry);
	}

	const children: Map<string | null, SessionEntry[]> = new Map();
	const roots: SessionEntry[] = [];
	for (const entry of allEntries) {
		const parentId =
			entry.parentId !== null && entries.has(entry.parentId)
				? entry.parentId
				: null;
		if (parentId === null) {
			roots.push(entry);
		}
		const siblings = children.get(parentId) ?? [];
		siblings.push(entry);
		children.set(parentId, siblings);
	}

	const sortByTimestamp = (a: SessionEntry, b: SessionEntry): number =>
		a.timestamp.localeCompare(b.timestamp);
	roots.sort(sortByTimestamp);
	for (const siblings of children.values()) {
		siblings.sort(sortByTimestamp);
	}

	let leafCount = 0;
	for (const entry of allEntries) {
		if ((children.get(entry.id) ?? []).length === 0) {
			leafCount++;
		}
	}
	const multiBranch = leafCount > 1 || roots.length > 1;

	const lines: string[] = [];
	roots.forEach((root, i) => {
		renderSegment(root.id, `${i + 1}`, children, entries, multiBranch, lines);
	});

	return lines.join("\n").trim();
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("summarize", {
		description: "Summarize the entire session, including all branches",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("summarize requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const conversationText = serializeSession(
				ctx.sessionManager.getEntries(),
			);
			if (!conversationText) {
				ctx.ui.notify("No conversation to summarize", "error");
				return;
			}

			const generated = await generateWithLoader(ctx, {
				loaderMessage: "Summarizing session...",
				systemPrompt: SYSTEM_PROMPT,
				userText: `## Session Conversation (all branches)\n\n${conversationText}`,
			});

			if (generated === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const summary = parseGeneratedSummary(generated);
			const newSessionResult = await editAndSeedChildSession(ctx, {
				editorTitle: "Edit session summary",
				generated: summary.summary,
				name: summary.title,
				customType: CONTEXT_CUSTOM_TYPE,
				toContent: (edited) => `${PROVENANCE_LABEL}\n\n${edited.trim()}`,
				readyNotice:
					"Previous session summary seeded. Send a message to continue.",
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("Cancelled", "info");
			}
		},
	});
}
