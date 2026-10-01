import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./utils/error-message";
import { generateHandoffPrompt } from "./utils/handoff";
import { deriveSessionName, flushSessionFile } from "./utils/session";
import {
	createWorktree,
	createWorktreeMetadata,
	exportWorktreePatch,
	getWorktreeState,
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
		readonly goal: string;
		readonly prompt: string;
	},
): Promise<void> {
	const session = SessionManager.create(options.root, undefined, {
		parentSession: ctx.sessionManager.getSessionFile(),
	});

	session.appendSessionInfo(deriveSessionName(options.goal));
	if (ctx.model) session.appendModelChange(ctx.model.provider, ctx.model.id);
	session.appendThinkingLevelChange(pi.getThinkingLevel());

	session.appendCustomEntry(
		WORKTREE_METADATA_TYPE,
		createWorktreeMetadata({
			worktreeRoot: options.root,
			parentRoot: options.parentRoot,
			baseCommit: options.baseCommit,
			sessionId: session.getSessionId(),
		}),
	);

	session.appendCustomMessageEntry(CONTEXT_TYPE, options.prompt, true);

	// Read back state
	const state = getWorktreeState(options.root, session.getEntries());
	if (state.kind !== "worktree") {
		throw new Error("Failed worktree session initialization.");
	}

	// Flush to disk to enable switching TUI into new session
	const file = await flushSessionFile(session);
	if (file === undefined) {
		throw new Error("No file path for the worktree session.");
	}

	const result = await ctx.switchSession(file, {
		withSession: async (replacement) => {
			replacement.ui.notify(
				`Worktree: ${state.metadata.worktreeRoot}\nPatch: ${state.metadata.patchPath}\nSend a message to continue.`,
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

			const generated = await generateHandoffPrompt(ctx, goal);
			if (generated === null) {
				return;
			}

			const prompt = await ctx.ui.editor("Edit worktree prompt", generated);
			if (prompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const result = await createWorktree(ctx.cwd);
			if (!result.ok) {
				ctx.ui.notify(result.error, "error");
				return;
			}

			try {
				await openWorktreeSession(pi, ctx, {
					...result,
					goal,
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
