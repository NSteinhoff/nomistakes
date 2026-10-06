/**
 * Discussion mode extension.
 *
 * Runtime authorization keeps tools and system guidance constant across authorization state.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { extractMessageText } from "./utils/message-text";

const STATUS_ID = "discussion";
const IMPLEMENTATION_TURN_PREFIXES = ["Implement", "Fix"];
const IMPLEMENTATION_TURN_SUFFIXES = ["Go!", "Do it!", "Make it so!"];
const SYSTEM_PROMPT_SECTION = "discussion-mode";

const BLOCKED_TOOLS = ["edit", "write", "move_file", "delete_file", "bash"];

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
	"Each user message sets authorization from its own token at delivery. This also applies to steering and follow-up messages. A message without a token revokes authorization from the previous message.",
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

	pi.on("before_agent_start", async (event) => {
		if (enabled) {
			event.systemPromptOptions.sections[SYSTEM_PROMPT_SECTION] =
				DISCUSSION_GUIDANCE;
		} else {
			delete event.systemPromptOptions.sections[SYSTEM_PROMPT_SECTION];
		}
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
