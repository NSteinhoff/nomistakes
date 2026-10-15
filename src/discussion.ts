/**
 * Discussion mode extension.
 *
 * Runtime authorization distinguishes discussion, implementation, and draft turns.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	createDraftPatch,
	DRAFT_PREFIX,
	DRAFT_SUFFIX,
	isDraftPrompt,
	PATCH_TOOL,
	patchParameters,
} from "./utils/draft";
import { extractMessageText } from "./utils/message-text";

const STATUS_ID = "discussion";
const IMPLEMENTATION_TURN_PREFIXES = ["Implement", "Fix"];
const IMPLEMENTATION_TURN_SUFFIXES = ["Go!", "Do it!", "Make it so!"];
const SYSTEM_PROMPT_SECTION = "discussion-mode";

const BLOCKED_TOOLS = ["edit", "write", "move_file", "delete_file", "bash"];

const DRAFT_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"status",
	PATCH_TOOL,
]);
const DRAFT_GUIDANCE = [
	`A ${DRAFT_PREFIX} prefix or ${DRAFT_SUFFIX} suffix authorizes only a patch proposal for this turn.`,
	`For a draft turn, inspect files and use ${PATCH_TOOL} to create the deliverable. Do not modify source files or the Git index.`,
	"For a draft turn, do not run builds, tests, formatters, baseline checks, or delegation. Draft turns are not implementation turns and implementation verification rules do not apply.",
	"For a draft turn, report only the patch path and a concise change summary. Do not add a verification notice.",
].join("\n");

const DISCUSSION_GUIDANCE = [
	"Discussion mode is enabled. The user can toggle it with /discussion.",
	"While enabled, the following tools are blocked:",
	...BLOCKED_TOOLS.map((toolName) => `- ${toolName}`),
	"Do not call these tools unless the current user message carries an authorization. Propose changes in prose and sample (pseudo) code instead.",
	"All other available tools, even mutating tools, are authorized. This mode is not a general read-only intent.",
	"",
	"Prefixes:",
	...IMPLEMENTATION_TURN_PREFIXES.map((prefix) => `- ${prefix}`),
	"",
	"Suffixes:",
	...IMPLEMENTATION_TURN_SUFFIXES.map((suffix) => `- ${suffix}`),
	"",
	DRAFT_GUIDANCE,
	"Each user message sets authorization for that turn from its own token at delivery. This also applies to steering and follow-up messages. A message without a token revokes authorization from the previous message.",
].join("\n");

function isImplementationTurn(text: string): boolean {
	const prompt = text.trim();

	if (
		IMPLEMENTATION_TURN_PREFIXES.some((prefix) => prompt.startsWith(prefix))
	) {
		return true;
	}

	if (IMPLEMENTATION_TURN_SUFFIXES.some((suffix) => prompt.endsWith(suffix))) {
		return true;
	}

	return false;
}

export default function discussionMode(pi: ExtensionAPI): void {
	let enabled = true;
	let implementationTurn = false;
	let draftTurn = false;
	let deliveredPrompt: string | null = null;

	pi.registerTool({
		name: PATCH_TOOL,
		label: "Create Patch",
		description:
			"Create a unified patch from unique, non-overlapping exact replacements in original text files. Source files remain unchanged. Available only for draft turns.",
		parameters: patchParameters,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!draftTurn) throw new Error("Patch creation requires a draft turn.");
			const patch = await createDraftPatch(ctx.cwd, params.name, params.files);
			return {
				content: [{ type: "text", text: `Patch: ${patch}` }],
				details: { patch },
			};
		},
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_ID,
			draftTurn
				? ctx.ui.theme.fg("accent", "[📝 DRAFT]")
				: enabled
					? implementationTurn
						? ctx.ui.theme.fg("warning", "[🔧 IMPLEMENTATION]")
						: ctx.ui.theme.fg("accent", "[💬 DISCUSSION]")
					: undefined,
		);
	}

	function toggle(ctx: ExtensionContext): void {
		enabled = !enabled;
		updateStatus(ctx);
		ctx.ui.notify(
			enabled
				? "Discussion mode enabled. Write tools require authorization."
				: "Discussion mode disabled. Write tools do not require authorization.",
			"info",
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		enabled = true;
		implementationTurn = false;
		draftTurn = false;
		deliveredPrompt = null;
		updateStatus(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (draftTurn) {
			if (DRAFT_TOOLS.has(event.toolName)) return;
			return {
				block: true,
				reason: "Draft turns permit only file inspection and patch creation.",
			};
		}
		if (event.toolName === PATCH_TOOL) {
			return { block: true, reason: "Patch creation requires a draft turn." };
		}
		if (
			!enabled ||
			implementationTurn ||
			!BLOCKED_TOOLS.includes(event.toolName)
		) {
			return;
		}

		return {
			block: true,
			reason: `[DISCUSSION MODE] The '${event.toolName}' tool requires authorization for this turn. Propose the change in prose instead.`,
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		deliveredPrompt = event.messageType === "user" ? event.prompt : null;
		draftTurn = deliveredPrompt !== null && isDraftPrompt(deliveredPrompt);
		implementationTurn = false;
		updateStatus(ctx);
		if (enabled) {
			event.systemPromptOptions.sections[SYSTEM_PROMPT_SECTION] =
				DISCUSSION_GUIDANCE;
		} else {
			event.systemPromptOptions.sections[SYSTEM_PROMPT_SECTION] =
				DRAFT_GUIDANCE;
		}
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "user") {
			return;
		}

		// Pi can append image hints after the authorization suffix.
		const text =
			deliveredPrompt ?? extractMessageText(event.message.content, "\n");
		deliveredPrompt = null;
		draftTurn = isDraftPrompt(text);
		implementationTurn = !draftTurn && isImplementationTurn(text);
		updateStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		implementationTurn = false;
		draftTurn = false;
		deliveredPrompt = null;
		updateStatus(ctx);
	});

	pi.registerCommand("discussion", {
		description:
			"Toggle discussion mode (require authorization for write tools)",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle discussion mode",
		handler: async (ctx) => toggle(ctx),
	});
}
