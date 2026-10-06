/**
 * Delegates tasks to specialized agents in isolated in-memory sessions.
 *
 * Invariants:
 * - Isolation is for context focus, not runtime sandboxing.
 * - Nested subagents are rejected.
 * - Hard deadlines request abort; the tool waits for in-process work to settle
 *   before returning.
 * - Agents fail loudly on malformed configuration.
 *
 * Agent definitions live in `<agentDir>/agents/<name>.md`. The body is the
 * agent system prompt; the YAML frontmatter is validated by
 * AgentFrontmatterSchema and supports these fields:
 * - description (string, required): agent role shown in the `delegate` tool.
 * - tools (string | string[]): comma-separated string or array of tool names.
 * - model (string): catalog model id; inherits the caller's when absent.
 * - thinkingLevel (enum): one of THINKING_LEVELS (case-sensitive).
 * - disabled (boolean | string): truthy excludes the agent from the registry.
 *
 * Command-generation fields drive the per-agent slash command registered by
 * registerDelegateCommands. Commands are namespaced as `/delegate:<name>` so
 * the whole set is discoverable by typing `/delegate:`. The command lands a
 * user message in the orchestrator (via sendUserMessage) so it composes the
 * final subagent prompt:
 * - command (boolean): false suppresses command generation for the agent.
 * - argument-hint (string): autocomplete hint, e.g. "<SCOPE>".
 * - completions (string[]): static argument completions offered in autocomplete.
 * - delegation-guidance (string): orchestrator message template; `$ARGUMENTS`
 *   is replaced with the command args, and templates without it ignore extra
 *   args. Falls back to a generic delegate-and-relay instruction when absent.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type {
	AgentMessage,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ModelRegistry,
	SessionEntry,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	getAgentDir,
	parseFrontmatter,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "./utils/error-message";
import { extractMessageText } from "./utils/message-text";
import {
	buildExpandableOutput,
	buildExpandableTailOutput,
	type ExpandableOutputDetails,
	formatThemedExpandableOutput,
	normalizeOutputText,
} from "./utils/tool-output";

interface AgentConfig {
	name: string;
	description: string;
	tools: string[] | undefined;
	model: string | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	systemPrompt: string;
	filePath: string;
	generateCommand: boolean;
	argumentHint: string | undefined;
	completions: string[] | undefined;
	delegationGuidance: string | undefined;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

interface SubagentResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: AgentMessage[];
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	phase?: SubagentPhase;
	modelLabel?: string;
	thinkingLevel?: string;
	durationMs?: number;
	costUsd?: number;
	contextTokens?: number;
	usage?: Usage | undefined;
}

type SubagentPhase =
	| "starting"
	| "running"
	| "completed"
	| "aborting"
	| "failed";

interface SubagentToolDetails extends Partial<ExpandableOutputDetails> {
	agent: string;
	task: string;
	exitCode: number;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
	phase?: SubagentPhase;
	modelLabel?: string;
	thinkingLevel?: string;
	durationMs?: number;
	costUsd?: number;
	contextTokens?: number;
	savedContextTokens?: number;
	fullText: string;
}

const SubagentParams = Type.Object({
	agent: Type.String({ description: "Agent name." }),
	task: Type.String({
		description:
			"The task to perform, named at a high level. The agent supplies its own procedure and output format. Add context only when its role description asks for it.",
	}),
});

// Deadline for requesting abort. Because tools run in-process, correctness
// requires waiting for delegated execution to settle even when a tool ignores
// its abort signal.
const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
const DISCUSSION_EXTENSION_FILE = "discussion.ts";

function getFinalOutput(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") {
			continue;
		}
		const textContent = extractMessageText(msg.content, "");
		if (textContent.length > 0) {
			return textContent;
		}
	}
	return "";
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	return getContentText(message.content);
}

function getToolResultText(result: unknown): string {
	if (!result || typeof result !== "object" || !("content" in result)) {
		return "";
	}
	return getContentText((result as { content: unknown }).content);
}

function getContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(formatContentPart).join("");
}

function formatContentPart(part: unknown): string {
	if (!part || typeof part !== "object" || !("type" in part)) return "";
	if (part.type === "text" && "text" in part) return String(part.text);
	if (part.type === "thinking") return "[thinking]";
	if (part.type === "image") return "[image]";
	if (part.type === "toolCall" && "name" in part) {
		return `[tool call: ${String(part.name)}]`;
	}
	return "";
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

function formatCost(usd: number): string {
	return `$${usd.toFixed(4)}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) {
		return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	}
	return `${(count / 1_000_000).toFixed(1)}M`;
}

// Mirrors estimateTokens' chars/4 heuristic for raw strings that never enter an
// AgentMessage envelope: the delegation task the parent emits and the tool
// output it receives back. These are the only two pieces of the subagent run
// that land in the parent context.
function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// Net context saving: the subagent's final context size minus the parts the
// parent still pays for (the delegated task and the returned output). Absent
// when the subagent context size is unknown (e.g. contextUsage right after an
// internal compaction).
function computeSavedContextTokens(
	contextTokens: number | undefined,
	task: string,
	parentOutput: string,
): number | undefined {
	if (contextTokens === undefined) return undefined;
	const delegationTokens = estimateTextTokens(`Task: ${task}`);
	const outputTokens = estimateTextTokens(parentOutput);
	return Math.max(0, contextTokens - delegationTokens - outputTokens);
}

function trimSingleLine(text: string, maxChars: number): string {
	const normalized = normalizeOutputText(text).replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function trimTailPreview(
	text: string,
	maxChars: number,
	maxLines: number,
): string {
	let normalized = normalizeOutputText(text);
	if (normalized.length > maxChars) {
		normalized = normalized.slice(-maxChars);
	}
	const lines = normalized.split("\n");
	if (lines.length <= maxLines) return normalized;
	return [
		`... (${lines.length - maxLines} earlier output lines hidden)`,
		...lines.slice(-maxLines),
	].join("\n");
}

const ACTIVITY_VERBS = [
	"STARTED",
	"SUBMITTED",
	"REQUESTED",
	"UPDATED",
	"COMPLETED",
	"FINISHED",
	"FAILED",
	"READY",
] as const;

type ActivityVerb = (typeof ACTIVITY_VERBS)[number];

// Widest verb, computed so the subject column never reflows.
const ACTIVITY_VERB_WIDTH = Math.max(
	...ACTIVITY_VERBS.map((verb) => verb.length),
);

class SubagentActivitySummary {
	private static readonly PREVIEW_CHARS = 4000;
	private static readonly PREVIEW_LINES = 14;
	private readonly entries: string[] = [];
	private streamingAssistantText = "";
	private latestOutputSource = "pending";
	private latestOutputText = "";

	constructor(
		private readonly agent: string,
		private readonly task: string,
	) {}

	append(entry: string) {
		const timestamp = new Date().toLocaleTimeString();
		this.entries.push(`${timestamp} ${entry}`);
	}

	appendEvent(verb: ActivityVerb, subject: string) {
		this.append(`${verb.padEnd(ACTIVITY_VERB_WIDTH)} ${subject}`);
	}

	appendAssistantDelta(delta: string) {
		this.streamingAssistantText += delta;
		if (
			this.streamingAssistantText.length > SubagentActivitySummary.PREVIEW_CHARS
		) {
			this.streamingAssistantText = this.streamingAssistantText.slice(
				-SubagentActivitySummary.PREVIEW_CHARS,
			);
		}
		this.setLatestOutput("assistant draft", this.streamingAssistantText);
	}

	startAssistantMessage() {
		this.streamingAssistantText = "";
	}

	setAssistantText(text: string) {
		this.streamingAssistantText = text.slice(
			-SubagentActivitySummary.PREVIEW_CHARS,
		);
		this.setLatestOutput("assistant output", this.streamingAssistantText);
	}

	setToolOutput(toolName: string, result: unknown, isError = false) {
		const text = getToolResultText(result);
		if (!text) return;
		this.setLatestOutput(
			`${isError ? "failed" : "finished"} tool ${toolName}`,
			text,
		);
	}

	setToolUpdate(toolName: string, result: unknown) {
		const text = getToolResultText(result);
		if (!text) return;
		this.setLatestOutput(`running tool ${toolName}`, text);
	}

	setStatusOutput(source: string, text: string) {
		this.setLatestOutput(source, text);
	}

	snapshot(messages: AgentMessage[], phase: SubagentPhase, elapsedMs: number) {
		const counts = countMessages(messages);
		const lastMessage = messages.findLast((message) => "role" in message);
		const lastMessageRole =
			lastMessage && "role" in lastMessage ? lastMessage.role : "none";
		const lastMessageText = lastMessage
			? trimSingleLine(getMessageText(lastMessage), 180)
			: "";
		const lines = [
			`Subagent ${this.agent}: ${phase}`,
			`Task: ${trimSingleLine(this.task, 240)}`,
			`Context: ${messages.length} messages (${counts.user} user, ${counts.assistant} assistant, ${counts.toolResult} tool results)`,
			`Last message: ${lastMessageRole}${lastMessageText ? ` — ${lastMessageText}` : ""}`,
		];
		if (this.entries.length > 0) {
			lines.push("", "Recent activity:", ...this.entries);
		}
		lines.push(
			"",
			"Latest output:",
			`Source: ${this.latestOutputSource}`,
			this.latestOutputText || "(no output yet)",
			"",
			`Elapsed: ${formatDuration(elapsedMs)}`,
		);
		return buildExpandableTailOutput(lines.join("\n"));
	}

	private setLatestOutput(source: string, text: string) {
		this.latestOutputSource = source;
		this.latestOutputText = trimTailPreview(
			text,
			SubagentActivitySummary.PREVIEW_CHARS,
			SubagentActivitySummary.PREVIEW_LINES,
		);
	}
}

function countMessages(messages: AgentMessage[]): {
	user: number;
	assistant: number;
	toolResult: number;
} {
	let user = 0;
	let assistant = 0;
	let toolResult = 0;
	for (const message of messages) {
		if (!("role" in message)) continue;
		if (message.role === "user") user++;
		else if (message.role === "assistant") assistant++;
		else if (message.role === "toolResult") toolResult++;
	}
	return { user, assistant, toolResult };
}

function isSessionBusy(session: AgentSession): boolean {
	return session.isStreaming || session.isRetrying || session.isCompacting;
}

function waitForPublicSessionIdle(session: AgentSession): Promise<void> {
	if (!isSessionBusy(session)) return Promise.resolve();
	let unsubscribe: (() => void) | undefined;
	return new Promise<void>((resolve) => {
		const checkIdle = () => {
			if (!isSessionBusy(session)) resolve();
		};
		// Single subscription for the whole wait: re-subscribing per event leaves
		// an unsubscribed gap in which a busy->idle transition can be missed.
		unsubscribe = session.subscribe((event) => {
			if (
				event.type === "agent_end" ||
				event.type === "auto_retry_end" ||
				event.type === "compaction_end"
			) {
				checkIdle();
			}
		});
		// Guard against a transition that settled between the entry check and subscribe.
		checkIdle();
	}).finally(() => {
		unsubscribe?.();
	});
}

/**
 * Resolve true if `promise` settles (resolves or rejects) within `ms`, false if
 * the timer wins first. Always attaches settlement handlers, so a later
 * rejection never surfaces as an unhandled rejection.
 */
function settlesWithin(
	promise: Promise<unknown>,
	ms: number,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let done = false;
		const finish = (settled: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(settled);
		};
		const timer = setTimeout(() => finish(false), ms);
		promise.then(
			() => finish(true),
			() => finish(true),
		);
	});
}

/**
 * Wait for `settlement` until the deadline. On deadline expiry, request abort
 * and continue waiting without a second deadline so in-process work cannot
 * outlive the tool call.
 */
async function waitForSettlementWithDeadline(
	settlement: Promise<void>,
	timeoutMs: number,
	onDeadline: () => void,
): Promise<boolean> {
	if (await settlesWithin(settlement, timeoutMs)) return false;
	onDeadline();
	await settlement.catch(() => {});
	return true;
}

function appendSubagentRolePrompt(
	base: string[],
	rolePrompt: string,
): string[] {
	const role = rolePrompt.trim();
	if (role.length === 0) return base;

	return [
		...base,
		[
			"<specialized_subagent_role>",
			"Inherited system and project instructions remain authoritative. Apply this role only within those constraints.",
			"",
			role,
			"</specialized_subagent_role>",
		].join("\n"),
	];
}

function createCompletionWaiter(session: AgentSession): {
	waitForPrompt: (prompt: Promise<void>) => Promise<void>;
	dispose: () => void;
} {
	let sawAgentEnd = false;
	let resolveAgentEnd: () => void = () => {};
	const agentEnd = new Promise<void>((resolve) => {
		resolveAgentEnd = resolve;
	});
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "agent_end") return;
		sawAgentEnd = true;
		resolveAgentEnd();
	});

	return {
		async waitForPrompt(prompt) {
			await prompt;
			if (!sawAgentEnd) await agentEnd;
			await session.agent.waitForIdle();
			await waitForPublicSessionIdle(session);
		},
		dispose: unsubscribe,
	};
}

async function runSubagent({
	agents,
	agent: agentName,
	task,
	cwd,
	fallbackModel,
	modelRegistry,
	activeTools,
	signal,
	onUpdate,
}: ExecuteSubagentArgs): Promise<SubagentResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
		};
	}

	const { tools, unavailableTools, nestedSubagentRequested } =
		resolveAgentTools(agent.tools, activeTools);
	if (nestedSubagentRequested) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Agent "${agentName}" requests the "delegate" tool, but nested subagents are not allowed.`,
		};
	}
	if (unavailableTools.length > 0) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unavailable tools for agent "${agentName}": ${unavailableTools.join(", ")}.`,
		};
	}
	const activity = new SubagentActivitySummary(agent.name, task);
	const startedAt = Date.now();
	let session: AgentSession | undefined;
	let exitCode = 0;
	let stderr = "";
	let aborted = false;
	let timedOut = false;
	let phase: SubagentPhase = "starting";
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let updateDirty = false;
	let updatesDisabled = false;
	let lastUpdateAt = 0;
	let onAbort: (() => void) | undefined;
	let abortPromise: Promise<void> | undefined;
	let abortErrorMessage: string | undefined;
	let unsubscribe: (() => void) | undefined;
	let messages: AgentMessage[] = [];
	let modelLabel: string | undefined;
	let thinkingLevel: string | undefined;
	let costUsd: number | undefined;
	let contextTokens: number | undefined;
	let usage: Usage | undefined;

	const emitUpdate = (nextPhase: SubagentPhase) => {
		if (!onUpdate || updatesDisabled) return;
		phase = nextPhase;
		updateDirty = false;
		lastUpdateAt = Date.now();
		const output = activity.snapshot(
			session?.messages ?? [],
			phase,
			lastUpdateAt - startedAt,
		);
		// Live context size and running net saving. Estimated against the output
		// produced so far; both grow as the subagent works and are undefined until
		// the session reports a context size.
		const liveContextTokens =
			session?.getSessionStats().contextUsage?.tokens ?? undefined;
		const liveSavedContextTokens = computeSavedContextTokens(
			liveContextTokens,
			task,
			getFinalOutput(session?.messages ?? []),
		);
		try {
			onUpdate({
				content: [{ type: "text", text: output.contentText }],
				details: {
					agent: agent.name,
					task,
					exitCode,
					stderr,
					phase,
					modelLabel,
					thinkingLevel,
					durationMs: lastUpdateAt - startedAt,
					contextTokens: liveContextTokens,
					savedContextTokens: liveSavedContextTokens,
					fullText: output.details.fullText,
					fullTextTruncated: output.details.fullTextTruncated,
					contentTruncation: output.details.contentTruncation,
					renderTruncation: output.details.renderTruncation,
				},
			});
		} catch (error) {
			updatesDisabled = true;
			updateDirty = false;
			console.warn(
				`[subagent] Disabling partial updates for agent "${agent.name}": ${errorMessage(error)}`,
			);
		}
	};

	const clearUpdateTimer = () => {
		if (!updateTimer) return;
		clearTimeout(updateTimer);
		updateTimer = undefined;
	};

	const removeAbortListener = () => {
		if (!signal || !onAbort) return;
		signal.removeEventListener("abort", onAbort);
		onAbort = undefined;
	};

	const scheduleUpdate = (nextPhase: SubagentPhase) => {
		if (!onUpdate || updatesDisabled) return;
		phase = nextPhase;
		updateDirty = true;
		const delay = 100 - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			clearUpdateTimer();
			emitUpdate(phase);
			return;
		}
		updateTimer ??= setTimeout(() => {
			updateTimer = undefined;
			if (updateDirty && !updatesDisabled) emitUpdate(phase);
		}, delay);
	};

	activity.appendEvent("STARTED", "task");
	emitUpdate("starting");
	try {
		const model = resolveAgentModel(agent.model, fallbackModel, modelRegistry);
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			// Discussion mode guides the parent conversation only; delegated agents
			// execute their assigned tasks without this extension.
			extensionsOverride: (base) => ({
				...base,
				extensions: base.extensions.filter(
					(extension) =>
						path.basename(extension.resolvedPath) !== DISCUSSION_EXTENSION_FILE,
				),
			}),
			appendSystemPromptOverride: (base) =>
				appendSubagentRolePrompt(base, agent.systemPrompt),
		});
		await resourceLoader.reload();
		settingsManager.applyOverrides({ compaction: { enabled: true } });
		const sessionResult = await createAgentSession({
			cwd,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			resourceLoader,
			model,
			tools,
			// Omit to inherit the settings default; the level is clamped to the
			// resolved model's capabilities by createAgentSession.
			thinkingLevel: agent.thinkingLevel,
		});
		session = sessionResult.session;
		const activeSession = session;
		modelLabel = activeSession.model?.name ?? activeSession.model?.id;
		thinkingLevel = activeSession.thinkingLevel;
		const requestAbort = () => {
			aborted = true;
			abortPromise ??= (async () => {
				// Defer the abort call until abortPromise is assigned so synchronous
				// abort events cannot start a duplicate request.
				await Promise.resolve();
				try {
					await activeSession.abort();
				} catch (error) {
					abortErrorMessage = errorMessage(error);
				}
			})();
		};
		unsubscribe = activeSession.subscribe((event) => {
			switch (event.type) {
				case "agent_start":
					activity.appendEvent("STARTED", "agent");
					if (aborted || signal?.aborted) {
						requestAbort();
						scheduleUpdate("aborting");
						break;
					}
					scheduleUpdate("running");
					break;
				case "message_start":
					if (event.message.role === "assistant") {
						activity.startAssistantMessage();
						activity.appendEvent("STARTED", "assistant message");
					}
					scheduleUpdate("running");
					break;
				case "message_update": {
					const messageEvent = event.assistantMessageEvent;
					if (messageEvent.type === "text_delta") {
						activity.appendAssistantDelta(messageEvent.delta);
					} else if (messageEvent.type === "thinking_start") {
						activity.appendEvent("STARTED", "assistant thinking");
					} else if (messageEvent.type === "toolcall_end") {
						activity.appendEvent(
							"REQUESTED",
							`tool "${messageEvent.toolCall.name}"`,
						);
					}
					scheduleUpdate("running");
					break;
				}
				case "message_end":
					if (event.message.role === "assistant") {
						const text = getMessageText(event.message);
						activity.setAssistantText(text);
						activity.appendEvent(
							"COMPLETED",
							`assistant message (${text.length} chars)`,
						);
					}
					scheduleUpdate("running");
					break;
				case "tool_execution_start":
					activity.appendEvent("STARTED", `tool "${event.toolName}"`);
					scheduleUpdate("running");
					break;
				case "tool_execution_update":
					activity.appendEvent("UPDATED", `tool "${event.toolName}"`);
					activity.setToolUpdate(event.toolName, event.partialResult);
					scheduleUpdate("running");
					break;
				case "tool_execution_end":
					activity.appendEvent(
						event.isError ? "FAILED" : "FINISHED",
						`tool "${event.toolName}"`,
					);
					activity.setToolOutput(event.toolName, event.result, event.isError);
					scheduleUpdate("running");
					break;
				case "agent_end":
					activity.appendEvent("FINISHED", "agent");
					scheduleUpdate("completed");
					break;
			}
		});
		activity.appendEvent("READY", "session");
		emitUpdate("running");
		if (signal) {
			if (signal.aborted) {
				throw new Error("Subagent was aborted");
			}
			onAbort = requestAbort;
			signal.addEventListener("abort", onAbort, { once: true });
		}

		if (aborted || signal?.aborted) {
			throw new Error("Subagent was aborted");
		}
		const completion = createCompletionWaiter(activeSession);
		try {
			const prompt = activeSession.sendUserMessage(`Task: ${task}`);
			activity.appendEvent("SUBMITTED", "task");
			scheduleUpdate("running");
			timedOut = await waitForSettlementWithDeadline(
				completion.waitForPrompt(prompt),
				SUBAGENT_TIMEOUT_MS,
				() => {
					activity.append(
						`deadline reached after ${Math.round(SUBAGENT_TIMEOUT_MS / 1000)}s; aborting`,
					);
					requestAbort();
					scheduleUpdate("aborting");
				},
			);
			removeAbortListener();
			await abortPromise;
		} finally {
			completion.dispose();
		}

		if (timedOut) {
			exitCode = 1;
			stderr = `Subagent timed out after ${Math.round(SUBAGENT_TIMEOUT_MS / 1000)}s; delegated execution settled after the abort request${abortErrorMessage ? ` (abort error: ${abortErrorMessage})` : ""}`;
			activity.append(stderr);
			activity.setStatusOutput("subagent timeout", stderr);
			emitUpdate("aborting");
		} else if (aborted || signal?.aborted) {
			exitCode = 1;
			stderr = `Subagent was aborted${abortErrorMessage ? ` (abort error: ${abortErrorMessage})` : ""}`;
			activity.append(stderr);
			activity.setStatusOutput("subagent status", stderr);
			emitUpdate("aborting");
		}
	} catch (error) {
		aborted = aborted || signal?.aborted === true;
		exitCode = 1;
		stderr = errorMessage(error);
		activity.append(`${aborted ? "aborting" : "failed"}: ${stderr}`);
		activity.setStatusOutput("subagent error", stderr);
		emitUpdate(aborted ? "aborting" : "failed");
	} finally {
		removeAbortListener();
		await abortPromise;
		clearUpdateTimer();
		unsubscribe?.();
		messages = session?.messages ?? [];
		// Raw entries retain usage that compaction removes from model context.
		usage = aggregateSessionUsage(session?.sessionManager.getEntries() ?? []);
		const stats = session?.getSessionStats();
		const sessionCost = usage?.cost.total;
		costUsd = sessionCost && sessionCost > 0 ? sessionCost : undefined;
		contextTokens = stats?.contextUsage?.tokens ?? undefined;
		session?.dispose();
	}

	const finalAssistant = messages.findLast((msg) => msg.role === "assistant");

	return {
		agent: agent.name,
		task,
		exitCode,
		messages,
		stderr,
		stopReason: finalAssistant?.stopReason,
		errorMessage: finalAssistant?.errorMessage,
		phase: exitCode !== 0 ? "failed" : "completed",
		modelLabel,
		thinkingLevel,
		durationMs: Date.now() - startedAt,
		costUsd,
		contextTokens,
		usage,
	};
}

function aggregateSessionUsage(
	entries: readonly SessionEntry[],
): Usage | undefined {
	let total: Usage | undefined;
	for (const entry of entries) {
		let usage: Usage | undefined;
		if (
			entry.type === "usage" ||
			entry.type === "compaction" ||
			entry.type === "branch_summary"
		) {
			usage = entry.usage;
		} else if (
			entry.type === "message" &&
			(entry.message.role === "assistant" ||
				entry.message.role === "toolResult")
		) {
			usage = entry.message.usage;
		}
		if (!usage) continue;
		if (!total) {
			total = { ...usage, cost: { ...usage.cost } };
			continue;
		}
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		if (usage.cacheWrite1h !== undefined) {
			total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
		}
		if (usage.reasoning !== undefined) {
			total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
		}
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

interface ExecuteSubagentArgs {
	agents: AgentConfig[];
	agent: string;
	task: string;
	cwd: string;
	fallbackModel: Model<Api> | undefined;
	modelRegistry: ModelRegistry;
	activeTools: string[];
	signal?: AbortSignal;
	onUpdate?: (partialResult: {
		content: { type: "text"; text: string }[];
		details: SubagentToolDetails;
	}) => void;
}

interface ExecuteSubagentOutput {
	content: { type: "text"; text: string }[];
	details: SubagentToolDetails;
	isError?: boolean;
	usage?: Usage | undefined;
}

function isErrorOutcome(outcome: {
	exitCode: number;
	stopReason?: string;
}): boolean {
	return (
		outcome.exitCode !== 0 ||
		outcome.stopReason === "error" ||
		outcome.stopReason === "aborted"
	);
}

async function execute(
	args: ExecuteSubagentArgs,
): Promise<ExecuteSubagentOutput> {
	const result = await runSubagent(args);

	if (isErrorOutcome(result)) {
		const errorMsg =
			result.errorMessage ||
			result.stderr ||
			getFinalOutput(result.messages) ||
			"(no output)";
		const fullText = `Agent failed: ${errorMsg}`;
		const output = buildExpandableOutput(fullText);
		return {
			content: [{ type: "text", text: output.contentText }],
			details: buildSubagentToolDetails(result, output),
			usage: result.usage,
			isError: true,
		};
	}

	const fullText = getFinalOutput(result.messages) || "(no output)";
	const output = buildExpandableOutput(fullText);
	return {
		content: [{ type: "text", text: output.contentText }],
		details: buildSubagentToolDetails(result, output),
		usage: result.usage,
	};
}

function buildSubagentToolDetails(
	result: SubagentResult,
	output: { contentText: string; details: ExpandableOutputDetails },
): SubagentToolDetails {
	// Estimate the saving against the content that actually lands in the parent
	// context (contentText, post-truncation), not the full untruncated output.
	const savedContextTokens = computeSavedContextTokens(
		result.contextTokens,
		result.task,
		output.contentText,
	);
	return {
		agent: result.agent,
		task: result.task,
		exitCode: result.exitCode,
		stderr: result.stderr,
		stopReason: result.stopReason,
		errorMessage: result.errorMessage,
		phase: result.phase,
		modelLabel: result.modelLabel,
		thinkingLevel: result.thinkingLevel,
		durationMs: result.durationMs,
		costUsd: result.costUsd,
		contextTokens: result.contextTokens,
		savedContextTokens,
		fullText: output.details.fullText,
		fullTextTruncated: output.details.fullTextTruncated,
		contentTruncation: output.details.contentTruncation,
		renderTruncation: output.details.renderTruncation,
	};
}

function formatModelAnnotationParts(
	modelLabel: string | undefined,
	thinkingLevel: string | undefined,
): string {
	return `${modelLabel || "inherit"} · ${thinkingLevel || "inherit"}`;
}

function formatModelAnnotation(details: SubagentToolDetails): string {
	return formatModelAnnotationParts(details.modelLabel, details.thinkingLevel);
}

function formatContextSavingParts(details: SubagentToolDetails): string[] {
	return [
		...(details.contextTokens !== undefined
			? [`ctx ${formatTokens(details.contextTokens)}`]
			: []),
		...(details.savedContextTokens !== undefined
			? [`saved ~${formatTokens(details.savedContextTokens)}`]
			: []),
	];
}

function formatPrefixedOutput(
	theme: Theme,
	color: ThemeColor,
	marker: string,
	text: string,
	header: string,
): string {
	const headerLine = `${theme.fg(color, marker)} ${theme.fg("dim", header)}`;
	// Bracket the status/metrics line with a rule above and below so it reads as
	// a distinct band. Sized to the header's visible width (marker + space +
	// text); callers pass uncolored strings, so length is the visible width.
	const rule = theme.fg("dim", "─".repeat(marker.length + 1 + header.length));
	const bracketed = `${rule}\n${headerLine}\n${rule}`;
	const normalized = normalizeOutputText(text);
	if (normalized.length === 0) return bracketed;
	const padding = " ".repeat(marker.length + 1);
	return `${bracketed}\n${normalized
		.split("\n")
		.map((line) => `${padding}${line}`)
		.join("\n")}`;
}

function failAgent(filePath: string, reason: string): never {
	throw new Error(`Invalid subagent definition ${filePath}: ${reason}`);
}

type ParseAgentToolsResult =
	| { ok: true; tools: string[] | undefined }
	| { ok: false; reason: string };

function parseAgentTools(
	value: string | string[] | undefined,
): ParseAgentToolsResult {
	if (value === undefined) return { ok: true, tools: undefined };
	const raw = typeof value === "string" ? value.split(",") : value;
	const tools = raw.map((tool) => tool.trim()).filter(Boolean);
	return tools.length > 0
		? { ok: true, tools }
		: { ok: false, reason: "tools must contain at least one tool" };
}

// Validates the shape/types of known agent frontmatter fields. The object is
// non-strict, so unknown keys pass through. Domain checks the schema cannot
// express cleanly (tool emptiness, thinkingLevel enum + case folding, disabled
// truthiness, command-name derivation) stay in the resolver helpers.
const AgentFrontmatterSchema = Type.Object({
	description: Type.String(),
	tools: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	model: Type.Optional(Type.String()),
	thinkingLevel: Type.Optional(
		Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level))),
	),
	disabled: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
	command: Type.Optional(Type.Boolean()),
	"argument-hint": Type.Optional(Type.String()),
	completions: Type.Optional(Type.Array(Type.String())),
	"delegation-guidance": Type.Optional(Type.String()),
});

type AgentFrontmatter = Static<typeof AgentFrontmatterSchema>;

function loadAgentsFromDir(dir: string): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (error) {
			failAgent(filePath, `unreadable: ${errorMessage(error)}`);
		}

		let parsed: { frontmatter: Record<string, unknown>; body: string };
		try {
			parsed = parseFrontmatter<Record<string, unknown>>(content);
		} catch (error) {
			failAgent(filePath, `invalid frontmatter: ${errorMessage(error)}`);
		}
		const { frontmatter, body } = parsed;

		const name = path.basename(entry.name, ".md").trim();
		if (!name) {
			failAgent(filePath, "empty file name");
		}

		if (!Value.Check(AgentFrontmatterSchema, frontmatter)) {
			const [first] = Value.Errors(AgentFrontmatterSchema, frontmatter);
			const at = first?.instancePath ? ` at '${first.instancePath}'` : "";
			failAgent(
				filePath,
				`invalid frontmatter${at}: ${first?.message ?? "schema mismatch"}`,
			);
		}

		const toolsResult = parseAgentTools(frontmatter.tools);
		if (!toolsResult.ok) {
			failAgent(filePath, toolsResult.reason);
		}

		const commandConfig = resolveCommandConfig(frontmatter);

		// Validate before honoring the opt-out so stale frontmatter is caught even
		// while disabled; disabled agents are then excluded from the active list
		// rather than skipped before validation.
		if (isAgentDisabled(frontmatter.disabled)) {
			continue;
		}

		agents.push({
			name,
			description: frontmatter.description,
			tools: toolsResult.tools,
			model: frontmatter.model,
			thinkingLevel: frontmatter.thinkingLevel,
			systemPrompt: body,
			filePath,
			generateCommand: commandConfig.generateCommand,
			argumentHint: commandConfig.argumentHint,
			completions: commandConfig.completions,
			delegationGuidance: commandConfig.delegationGuidance,
		});
	}

	return agents;
}

function isAgentDisabled(disabled: unknown): boolean {
	if (typeof disabled === "boolean") return disabled;
	if (typeof disabled !== "string") return false;
	const normalized = disabled.trim().toLowerCase();
	return ["true", "1", "yes", "on", "disabled"].includes(normalized);
}

type CommandConfig = {
	generateCommand: boolean;
	argumentHint: string | undefined;
	completions: string[] | undefined;
	delegationGuidance: string | undefined;
};

// Resolves the command config from already-validated frontmatter, trimming the
// optional fields. Shape validation lives in AgentFrontmatterSchema, so this
// cannot fail.
function resolveCommandConfig(fm: AgentFrontmatter): CommandConfig {
	const completions = fm.completions
		?.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	return {
		generateCommand: fm.command !== false,
		argumentHint: fm["argument-hint"]?.trim() || undefined,
		completions:
			completions && completions.length > 0 ? completions : undefined,
		delegationGuidance: fm["delegation-guidance"]?.trim() || undefined,
	};
}

function discoverAgents(): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");
	return loadAgentsFromDir(userDir);
}

function formatAgent(agent: AgentConfig): string {
	const annotations = [
		...(agent.model ? [agent.model] : []),
		...(agent.thinkingLevel ? [`thinking: ${agent.thinkingLevel}`] : []),
	];
	const suffix = annotations.length > 0 ? ` [${annotations.join(", ")}]` : "";
	return `- ${agent.name}${suffix}: ${agent.description}`;
}

function resolveAgentTools(
	agentTools: string[] | undefined,
	activeTools: string[],
): {
	tools: string[];
	unavailableTools: string[];
	nestedSubagentRequested: boolean;
} {
	const allowedActive = activeTools.filter((tool) => tool !== "delegate");
	if (agentTools === undefined) {
		return {
			tools: allowedActive,
			unavailableTools: [],
			nestedSubagentRequested: false,
		};
	}
	// Recursion guard: an explicit "delegate" request is reported separately from
	// genuinely unavailable tools so the caller can explain why it is rejected.
	const nestedSubagentRequested = agentTools.includes("delegate");
	const requested = agentTools.filter((tool) => tool !== "delegate");
	const activeSet = new Set(allowedActive);
	const tools = requested.filter((tool) => activeSet.has(tool));
	const unavailableTools = [
		...new Set(requested.filter((tool) => !activeSet.has(tool))),
	];
	return { tools, unavailableTools, nestedSubagentRequested };
}

function resolveAgentModel(
	agentModel: string | undefined,
	fallbackModel: Model<Api> | undefined,
	modelRegistry: ModelRegistry,
): Model<Api> | undefined {
	if (!agentModel) {
		return fallbackModel;
	}

	const byScopedId = agentModel.includes("/")
		? (() => {
				const [provider, ...idParts] = agentModel.split("/");
				const modelId = idParts.join("/");
				return provider && modelId
					? modelRegistry.find(provider, modelId)
					: undefined;
			})()
		: undefined;

	if (byScopedId) {
		return byScopedId;
	}

	if (fallbackModel) {
		const byInheritedProvider = modelRegistry.find(
			fallbackModel.provider,
			agentModel,
		);

		if (byInheritedProvider) {
			return byInheritedProvider;
		}
	}
	throw new Error(
		`Unknown agent model: ${agentModel}. Use provider/modelId or ensure the model exists for the inherited provider.`,
	);
}

function firstLine(text: string): string {
	const line = text.split(/\r?\n/).find((entry) => entry.trim().length > 0);
	return (line ?? text).trim();
}

function defaultDelegationGuidance(name: string): string {
	return [
		`Delegate to \`${name}\` for: $ARGUMENTS.`,
		"Compose a focused task prompt and relay the report. If no scope is given, use a sensible default.",
	].join("\n");
}

// Args interpolate only where the template contains $ARGUMENTS, matching
// prompt-template semantics; templates without it ignore extra args.
function buildDelegationMessage(agent: AgentConfig, args: string): string {
	const template =
		agent.delegationGuidance ?? defaultDelegationGuidance(agent.name);
	return template.split("$ARGUMENTS").join(args).trim();
}

function registerDelegateCommands(
	pi: ExtensionAPI,
	agents: AgentConfig[],
): void {
	for (const agent of agents) {
		if (!agent.generateCommand) continue;
		const description = agent.argumentHint
			? `${agent.argumentHint} ${firstLine(agent.description)}`
			: firstLine(agent.description);
		const completions = agent.completions;
		// Namespaced under `delegate:` so the whole set is discoverable by typing
		// `/delegate:` in the editor.
		pi.registerCommand(`delegate:${agent.name}`, {
			description,
			getArgumentCompletions: completions
				? (prefix: string): AutocompleteItem[] | null => {
						const query = prefix.trim().toLowerCase();
						const items = completions
							.filter((entry) => entry.toLowerCase().startsWith(query))
							.map((entry) => ({ value: entry, label: entry }));
						return items.length > 0 ? items : null;
					}
				: undefined,
			handler: async (args, _ctx) => {
				await pi.sendUserMessage(buildDelegationMessage(agent, args.trim()));
			},
		});
	}
}

export default function (pi: ExtensionAPI) {
	const discoveredAgents = discoverAgents();
	const formattedAgentList = discoveredAgents.map(formatAgent);

	registerDelegateCommands(pi, discoveredAgents);
	pi.registerTool<typeof SubagentParams, SubagentToolDetails>({
		name: "delegate",
		exposure: "model-only",
		label: "Subagent",
		description: [
			"Delegate a focused task to a specialized subagent with isolated conversation context and resolved tools.",
			"Each agent has its own instructions and knows how to perform its task: name the task, do not describe how to do it. Add context only when the agent's role description asks for it.",
			"Use for high-signal outcomes/evidence, not runtime sandboxing.",
			"Delegate only when the task matches a listed agent's role. Otherwise act directly. Pick the narrowest role that fits.",
			"Available agents:",
			...formattedAgentList,
		].join("\n"),
		parameters: SubagentParams,
		// Runs a nested in-process agent loop that can trigger blocking UI and
		// streams output; concurrent subagents would interleave and clash.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return execute({
				agents: discoveredAgents,
				agent: params.agent,
				task: params.task,
				cwd: ctx.cwd,
				fallbackModel: ctx.model,
				modelRegistry: ctx.modelRegistry,
				activeTools: pi.getActiveTools(),
				signal,
				onUpdate,
			});
		},

		renderCall(args, theme) {
			const task = typeof args.task === "string" ? args.task : "...";
			const agentName = typeof args.agent === "string" ? args.agent : "...";
			const agent = discoveredAgents.find((entry) => entry.name === agentName);
			const { unavailableTools, nestedSubagentRequested } = resolveAgentTools(
				agent?.tools,
				pi.getActiveTools(),
			);
			const warnings = [
				...(nestedSubagentRequested ? ["nested subagents not allowed"] : []),
				...(unavailableTools.length > 0
					? [`dropped tools: ${unavailableTools.join(", ")}`]
					: []),
			];
			const droppedLine =
				warnings.length > 0
					? `\n  ${theme.fg("warning", warnings.join("; "))}`
					: "";
			// renderCall only sees configured frontmatter values; an inherited
			// model/level resolves later in the session, so it shows as "inherit".
			const annotation = formatModelAnnotationParts(
				agent?.model,
				agent?.thinkingLevel,
			);
			return new Text(
				theme.fg("toolTitle", theme.bold("delegate ")) +
					theme.fg("accent", agentName) +
					theme.fg("dim", ` · ${annotation}`) +
					droppedLine +
					`\n  ${theme.fg("dim", task)}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			if (options.isPartial) {
				const details = result.details;
				return new Text(
					formatPrefixedOutput(
						theme,
						"accent",
						"…",
						formatThemedExpandableOutput(details, options.expanded, theme, 28, {
							edge: "tail",
							fallbackText: details.renderTruncation?.truncated
								? ""
								: "Subagent running",
						}),
						[
							formatModelAnnotation(details),
							...formatContextSavingParts(details),
						].join(" · "),
					),
					0,
					0,
				);
			}
			const details = result.details;
			const isError = isErrorOutcome(details);
			const header = [
				formatModelAnnotation(details),
				...(details.durationMs !== undefined
					? [formatDuration(details.durationMs)]
					: []),
				...(details.costUsd !== undefined ? [formatCost(details.costUsd)] : []),
				...formatContextSavingParts(details),
			].join(" · ");
			return new Text(
				formatPrefixedOutput(
					theme,
					isError ? "warning" : "success",
					isError ? "✗" : "✓",
					formatThemedExpandableOutput(details, options.expanded, theme, 28, {
						fallbackText: details.renderTruncation?.truncated
							? ""
							: "(no output)",
					}),
					header,
				),
				0,
				0,
			);
		},
	});
}
