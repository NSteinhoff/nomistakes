import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./utils/error-message";
import { generateHandoff } from "./utils/handoff";
import { flushSessionFile } from "./utils/session";
import { createSnapshot, SNAPSHOT_RESET_EVENT } from "./utils/snapshot";
import {
	createWorktree,
	createWorktreeMetadata,
	exportWorktreePatch,
	getWorktreeState,
	updateWorktree,
	WORKTREE_METADATA_TYPE,
} from "./utils/worktree";

const CONTEXT_TYPE = "worktree-prompt";
const STATUS_ID = "worktree";

async function openWorktreeSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	options: {
		readonly root: string;
		readonly parentRoot: string;
		readonly baseCommit: string;
		readonly title: string;
		readonly prompt: string;
	},
): Promise<void> {
	const session = SessionManager.create(options.root, undefined, {
		parentSession: ctx.sessionManager.getSessionFile(),
	});

	session.appendSessionInfo(options.title);
	if (ctx.model) session.appendModelChange(ctx.model.provider, ctx.model.id);
	session.appendThinkingLevelChange(pi.getThinkingLevel());

	const metadata = createWorktreeMetadata({
		worktreeRoot: options.root,
		parentRoot: options.parentRoot,
		baseCommit: options.baseCommit,
	});
	session.appendCustomEntry(WORKTREE_METADATA_TYPE, metadata);
	session.appendCustomMessageEntry(CONTEXT_TYPE, options.prompt, true);

	// Custom context alone does not persist the session.
	const file = await flushSessionFile(session);
	if (file === undefined) {
		throw new Error("No file path for the worktree session.");
	}

	const result = await ctx.switchSession(file, {
		withSession: async (replacement) => {
			replacement.ui.notify(
				`Worktree: ${metadata.worktreeRoot}\nPatch: ${metadata.patchPath}\nSend a message to continue.`,
				"info",
			);
		},
	});

	if (result.cancelled) {
		ctx.ui.notify(
			`Switch cancelled. Retained worktree: ${options.root}\nSession: ${file}`,
			"info",
		);
	}
}

async function announceWorktreeUpdate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string,
): Promise<void> {
	const checkpoint = await createSnapshot({
		cwd: root,
		description: "worktree update checkpoint",
	});
	if (checkpoint.ok) {
		pi.events.emit(SNAPSHOT_RESET_EVENT, checkpoint.snapshot);
	} else {
		ctx.ui.notify(
			`Worktree updated, but snapshot reset failed: ${checkpoint.error}`,
			"warning",
		);
	}
	pi.sendMessage(
		{
			customType: "worktree-update",
			content:
				"The worktree now matches the parent checkout. All previous local worktree changes were discarded. Re-read relevant files before further edits. Subsequent patches use the new base.",
			display: true,
		},
		{ deliverAs: "nextTurn" },
	);
}

export default function worktree(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const state = getWorktreeState(ctx.cwd, ctx.sessionManager.getEntries());

		if (state.kind === "invalid") {
			ctx.ui.notify(state.error, "error");
		}

		ctx.ui.setStatus(
			STATUS_ID,
			state.kind === "worktree"
				? ctx.ui.theme.fg("accent", "[🏗️ WORKTREE]")
				: undefined,
		);
	});

	pi.on("agent_end", async (_event, ctx) => {
		const state = getWorktreeState(ctx.cwd, ctx.sessionManager.getEntries());

		if (state.kind === "none") {
			return;
		}

		if (state.kind === "invalid") {
			ctx.ui.notify(`${state.error} The patch is stale or absent.`, "error");
			return;
		}

		try {
			await exportWorktreePatch(state.metadata);
			ctx.ui.notify(`Patch: ${state.metadata.patchPath}`, "info");
		} catch (error) {
			const message = errorMessage(error);
			ctx.ui.notify(
				`Patch export failed: ${message}\nThe patch is stale or absent: ${state.metadata.patchPath}`,
				"error",
			);
		}
	});

	pi.registerCommand("worktree-update", {
		description: "Replace this worktree with the current parent checkout",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("worktree-update requires interactive mode", "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish.", "error");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /worktree-update", "error");
				return;
			}
			const state = getWorktreeState(ctx.cwd, ctx.sessionManager.getEntries());
			if (state.kind !== "worktree") {
				ctx.ui.notify(
					state.kind === "invalid" ? state.error : "Not a worktree session.",
					"error",
				);
				return;
			}
			const sessionManager = ctx.sessionManager;
			if (!(sessionManager instanceof SessionManager)) {
				ctx.ui.notify(
					"The session cannot persist a new worktree base.",
					"error",
				);
				return;
			}
			const confirmed = await ctx.ui.confirm(
				"Replace worktree?",
				`Discard all local changes and extra files, including ignored files, in ${state.metadata.worktreeRoot}. Replace them with the current checkout at ${state.metadata.parentRoot}. Session history remains unchanged.`,
			);
			if (!confirmed) return;
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish.", "error");
				return;
			}
			try {
				await updateWorktree(state.metadata, (metadata) => {
					sessionManager.appendCustomEntry(WORKTREE_METADATA_TYPE, metadata);
				});
				await announceWorktreeUpdate(pi, ctx, state.metadata.worktreeRoot);
				ctx.ui.notify(
					`Worktree updated. Patch: ${state.metadata.patchPath}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Worktree update failed: ${errorMessage(error)}\nThe worktree can be incomplete. The patch is stale or absent: ${state.metadata.patchPath}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("worktree", {
		description: "Transfer context to a new session in an isolated worktree",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("worktree requires interactive mode", "error");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to finish.", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /worktree <goal for new thread>", "error");
				return;
			}

			const generated = await generateHandoff(ctx, goal);
			if (generated === null) {
				return;
			}

			const prompt = await ctx.ui.editor(
				"Edit worktree prompt",
				generated.prompt,
			);
			if (prompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const result = await createWorktree(ctx.cwd, generated.title);
			if (!result.ok) {
				ctx.ui.notify(result.error, "error");
				return;
			}

			try {
				await openWorktreeSession(pi, ctx, {
					...result,
					title: generated.title,
					prompt: prompt.trim(),
				});
			} catch (error) {
				const notice = `${errorMessage(error)}\nRetained worktree: ${result.root}`;
				try {
					ctx.ui.notify(notice, "error");
				} catch {
					// Session replacement can invalidate ctx before a failure returns.
					console.error(notice);
				}
			}
		},
	});
}
