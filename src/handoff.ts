import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateHandoff } from "./utils/handoff";
import { editAndSeedChildSession } from "./utils/session";

const HANDOFF_CUSTOM_TYPE = "handoff-prompt";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}
			const result = await generateHandoff(ctx, goal);
			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			const newSessionResult = await editAndSeedChildSession(ctx, {
				editorTitle: "Edit handoff prompt",
				generated: result.prompt,
				name: result.title,
				customType: HANDOFF_CUSTOM_TYPE,
				readyNotice: "Handoff seeded. Send a message to continue.",
			});
			if (newSessionResult.cancelled) ctx.ui.notify("Cancelled", "info");
		},
	});
}
