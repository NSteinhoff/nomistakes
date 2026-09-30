/**
 * Discussion mode extension.
 *
 * Runtime authorization keeps tools and system guidance constant across modes.
 */

import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const STATUS_ID = "discussion";
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
	"Discussion mode defaults to enabled. The user can toggle it with /discussion.",
	"While enabled, propose changes in prose. Do not implement changes or invoke",
	"mutating tools unless the current user message carries an authorization",
	"prefix or suffix. Subagent delegation is allowed.",
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
	"Restricted tool calls return a refusal message while discussion mode is",
	"enabled and the current turn lacks authorization. When the user disables",
	"discussion mode, this restriction does not apply.",
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
				? "Discussion mode enabled. Write tools require authorization."
				: "Discussion mode disabled. Write tools do not require authorization.",
			"info",
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		enabled = true;
		implementationTurn = false;
		updateStatus(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!enabled || implementationTurn || !BLOCKED_TOOLS.has(event.toolName)) {
			return;
		}

		return {
			block: true,
			reason: `[DISCUSSION MODE] The '${event.toolName}' tool requires authorization for this turn. Propose the change in prose instead.`,
		};
	});

	pi.on("before_agent_start", async (event) => {
		implementationTurn = isImplementationTurn(event);
		event.systemPromptOptions.sections["discussion-mode"] = DISCUSSION_GUIDANCE;
	});

	pi.on("agent_end", async () => {
		implementationTurn = false;
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
