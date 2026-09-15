/**
 * Discussion mode extension.
 *
 * A lightweight guidance toggle for planning/discussion turns. While enabled,
 * mutating tool calls are blocked with a reminder that we are discussing, not
 * editing. This is guidance, not enforcement: tools stay registered and active
 * so the agent keeps full visibility and is nudged back to prose rather than
 * hunting for workarounds. Loopholes (e.g. shells) are expected and out of
 * scope.
 *
 * Mechanics:
 * - tool_call gate blocks a fixed set of write tools while enabled. Blocking
 *   carries a reason but no terminate, so the agent continues reasoning.
 * - before_agent_start appends fixed guidance while enabled; a user message
 *   with a recognized implementation prefix temporarily permits write tools for
 *   that agent run. The context hook strips legacy injected notes.
 * - /discussion command and Ctrl+Alt+D toggle the mode.
 * - Footer badge reflects the current state.
 *
 * State is ephemeral and enabled by default: every session start (startup,
 * resume, reload, new, fork) re-enables the mode. The user toggles it off when
 * ready to implement. It is never persisted.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const STATUS_ID = "discussion";
const NOTE_TYPE = "discussion-note";
const BLOCKED_TOOLS = new Set<string>([
	"edit",
	"write",
	"move_file",
	"delete_file",
	"bash",
]);
const IMPLEMENTATION_TURN_PREFIXES = ["Implement", "Fix"];
const IMPLEMENTATION_TURN_SUFFIXES = ["Go!", "Do it!", "Make it so!"];
const DISCUSSION_GUIDANCE = [
	"<discussion-mode>",
	"Discussion mode is enabled.",
	"",
	"Discuss, analyze, and plan. Do not implement changes or invoke mutating tools",
	"unless the current user message carries an authorization prefix or suffix.",
	"",
	"Prefixes:",
	...IMPLEMENTATION_TURN_PREFIXES.map((prefix) => `- ${prefix}`),
	"",
	"Suffixes:",
	...IMPLEMENTATION_TURN_SUFFIXES.map((suffix) => `- ${suffix}`),
	"",
	"Authorization is per-message. It applies only to the turn whose message",
	"carries the token and never persists to later turns. A prior authorization",
	"does not license edits in a subsequent turn, even a directly related one.",
	"",
	"Without authorization, propose changes in prose.",
	"</discussion-mode>",
].join("\n");

function blockReason(toolName: string): string {
	return `[DISCUSSION MODE] We're currently discussing and planning, not editing. The '${toolName}' tool is disabled. Propose the change in prose instead; the user will leave discussion mode when ready to implement.`;
}

function isImplementationTurn(event: BeforeAgentStartEvent): boolean {
	const prompt = event.prompt.trim();

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

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_ID,
			enabled ? ctx.ui.theme.fg("accent", "💬 DISCUSSION") : undefined,
		);
	}

	function toggle(ctx: ExtensionContext): void {
		enabled = !enabled;
		updateStatus(ctx);
		ctx.ui.notify(
			enabled
				? "Discussion mode enabled. Write tools are blocked."
				: "Discussion mode disabled. Write tools restored.",
			"info",
		);
	}

	// Discussion mode is the default: re-enable on every session start so resume,
	// reload, and new sessions all begin in planning-only mode.
	pi.on("session_start", async (_event, ctx) => {
		enabled = true;
		updateStatus(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!enabled || implementationTurn || !BLOCKED_TOOLS.has(event.toolName)) {
			return;
		}
		return { block: true, reason: blockReason(event.toolName) };
	});

	pi.on("before_agent_start", async (event) => {
		implementationTurn = isImplementationTurn(event);
		if (!enabled) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${DISCUSSION_GUIDANCE}`,
		};
	});

	pi.on("agent_end", async () => {
		implementationTurn = false;
	});

	// Exclude notes injected by earlier extension versions from every context.
	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter(
				(message) =>
					(message as AgentMessage & { customType?: string }).customType !==
					NOTE_TYPE,
			),
		};
	});

	pi.registerCommand("discussion", {
		description: "Toggle discussion mode (block write tools during planning)",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle discussion mode",
		handler: async (ctx) => toggle(ctx),
	});
}
