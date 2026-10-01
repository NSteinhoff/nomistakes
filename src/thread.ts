/**
 * Thread extension - spawn a new empty child session
 *
 * Unlike /handoff (which extracts context) or /fork (which branches from a
 * message), /thread creates a fresh, empty session that tracks the current
 * session as its parent. Use it to organize related sessions into threads or
 * projects without transferring any context.
 *
 * Usage:
 *   /thread payments refactor
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deriveSessionName, openChildSession } from "./utils/session";
import { blockWorktreeSessionCreation } from "./utils/worktree-patch";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("thread", {
		description: "Spawn a new empty child session",
		handler: async (args, ctx) => {
			if (await blockWorktreeSessionCreation(pi, ctx)) return;
			if (ctx.mode !== "tui") {
				ctx.ui.notify("thread requires interactive mode", "error");
				return;
			}

			const label = args.trim();
			if (!label) {
				ctx.ui.notify("Usage: /thread <label for new thread>", "error");
				return;
			}

			const result = await openChildSession(ctx, {
				name: deriveSessionName(label),
			});

			if (result.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
