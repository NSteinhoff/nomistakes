/**
 * Discussion mode extension.
 *
 * Runtime authorization keeps tools and system guidance constant across modes.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractMessageText } from "./utils/message-text";

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
	"Each user message sets authorization from its own token at delivery.",
	"This also applies to steering and follow-up messages. A message without",
	"a token revokes authorization from the previous message.",
	"",
	"Restricted tool calls return a refusal message while discussion mode is",
	"enabled and the current turn lacks authorization. When the user disables",
	"discussion mode, this restriction does not apply.",
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

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			STATUS_ID,
			enabled
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
		event.systemPromptOptions.sections["discussion-mode"] = DISCUSSION_GUIDANCE;
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "user") {
			return;
		}

		const text = extractMessageText(event.message.content, "\n");
		implementationTurn = isImplementationTurn(text);
		updateStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		implementationTurn = false;
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
