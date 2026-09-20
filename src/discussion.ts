/**
 * Discussion mode extension.
 *
 * Planning turns use a readonly tool loadout. The mode stays ephemeral and
 * defaults to enabled for every session start.
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
].join("\n");

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
				? "Discussion mode enabled. Write tools are unavailable on planning turns."
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

	pi.on("before_agent_start", async (event) => {
		if (enabled && !isImplementationTurn(event)) {
			event.systemPromptOptions.selectedTools =
				event.systemPromptOptions.selectedTools.filter(
					(toolName) => !BLOCKED_TOOLS.has(toolName),
				);
			event.systemPromptOptions.sections["discussion-mode"] =
				DISCUSSION_GUIDANCE;
			return;
		}

		delete event.systemPromptOptions.sections["discussion-mode"];
		pi.setActiveTools(event.systemPromptOptions.selectedTools);
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
		description: "Toggle discussion mode (use readonly tools during planning)",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "Toggle discussion mode",
		handler: async (ctx) => toggle(ctx),
	});
}
