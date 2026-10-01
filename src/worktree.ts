import { realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { generateHandoffPrompt } from "./utils/handoff";
import { deriveSessionName } from "./utils/session";
import { createWorktree, removeWorktree } from "./utils/worktree";
import {
	blockWorktreeSessionCreation,
	createWorktreeMetadata,
	ensureWorktreeMetadata,
	exportWorktreePatch,
	getWorktreeParentSession,
	registerWorktreeOwner,
	WORKTREE_METADATA_TYPE,
} from "./utils/worktree-patch";

const CONTEXT_TYPE = "worktree-prompt";
const CLEANUP_KEY = Symbol.for("pi.worktree.cleanup");
// Session replacement reloads extensions. The lock must survive that reload.
const cleanupHost = globalThis as typeof globalThis & {
	[CLEANUP_KEY]?: {
		readonly sessionId: string;
		readonly parentFile: string;
		allowParentSwitch: boolean;
	};
};

function assertSessionOutsideWorktree(root: string, file: string): void {
	const relative = path.relative(root, file);
	if (
		relative === "" ||
		(relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative))
	)
		throw new Error(
			"Session files must reside outside the worktree before cleanup.",
		);
}

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
	const metadata = createWorktreeMetadata({
		worktreeRoot: options.root,
		parentRoot: options.parentRoot,
		baseCommit: options.baseCommit,
		sessionId: session.getSessionId(),
	});
	session.appendCustomEntry(WORKTREE_METADATA_TYPE, metadata);
	session.appendSessionInfo(deriveSessionName(options.goal));
	if (ctx.model) session.appendModelChange(ctx.model.provider, ctx.model.id);
	session.appendThinkingLevelChange(pi.getThinkingLevel());
	session.appendCustomMessageEntry(
		CONTEXT_TYPE,
		`Worktree session.\nWorktree checkout: ${metadata.worktreeRoot}\nParent checkout: ${metadata.parentRoot}\nBase commit: ${metadata.baseCommit}\nPatch: ${metadata.patchPath}\nResolve file paths within this checkout. Session creation is blocked. The patch refreshes after each agent turn. Integration remains manual. Use /destroy for confirmed cleanup. Implementation requires fresh authorization.\n\n${options.prompt}`,
		true,
	);
	const file = session.getSessionFile();
	if (file === undefined)
		throw new Error("No file path for the worktree session.");
	// Custom context alone does not trigger persistence. Resume requires a file.
	await writeFile(
		file,
		`${[session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		{ flag: "wx" },
	);
	await registerWorktreeOwner(metadata.worktreeRoot, file);
	const result = await ctx.switchSession(file, {
		withSession: async (replacement) => {
			replacement.ui.notify(
				`Worktree: ${metadata.worktreeRoot}\nPatch: ${metadata.patchPath}\nSend a message to continue.`,
				"info",
			);
		},
	});
	if (result.cancelled)
		ctx.ui.notify(
			`Switch cancelled. Retained worktree: ${options.root}\nSession: ${file}`,
			"info",
		);
}

function registerPatchLifecycle(pi: ExtensionAPI): void {
	pi.on("session_before_switch", async (event, ctx) => {
		const cleanup = cleanupHost[CLEANUP_KEY];
		if (cleanup) {
			if (
				cleanup.allowParentSwitch &&
				event.reason === "resume" &&
				event.targetSessionFile === cleanup.parentFile &&
				ctx.sessionManager.getSessionId() === cleanup.sessionId
			) {
				cleanup.allowParentSwitch = false;
				return;
			}
			ctx.ui.notify(
				"Session changes are blocked during worktree cleanup.",
				"error",
			);
			return { cancel: true };
		}
		if (event.reason !== "new") return;
		if (await blockWorktreeSessionCreation(pi, ctx)) return { cancel: true };
	});
	pi.on("session_before_fork", async (_event, ctx) => {
		if (cleanupHost[CLEANUP_KEY]) {
			ctx.ui.notify(
				"Session changes are blocked during worktree cleanup.",
				"error",
			);
			return { cancel: true };
		}
		if (await blockWorktreeSessionCreation(pi, ctx)) return { cancel: true };
	});
	pi.on("input", (_event, ctx) => {
		if (!cleanupHost[CLEANUP_KEY]) return;
		ctx.ui.notify("Wait for worktree cleanup to finish.", "error");
		return { action: "handled" };
	});
	pi.on("session_start", async (_event, ctx) => {
		const state = await ensureWorktreeMetadata(pi, ctx);
		if (state.kind === "invalid") ctx.ui.notify(state.error, "error");
		if (state.kind === "worktree") registerDestroyCommand(pi);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const state = await ensureWorktreeMetadata(pi, ctx);
		if (state.kind === "none") return;
		if (state.kind === "invalid") {
			ctx.ui.notify(
				`${state.error} Automatic patch export is disabled.`,
				"error",
			);
			return;
		}
		const metadata = state.metadata;
		event.systemPromptOptions.sections[WORKTREE_METADATA_TYPE] =
			`This is a worktree session. Worktree: ${metadata.worktreeRoot}. Parent checkout: ${metadata.parentRoot}. Patch: ${metadata.patchPath}. The patch refreshes after each agent turn. Session creation is blocked. Integration remains manual. Use /destroy for confirmed cleanup.`;
	});
	pi.on("agent_end", async (_event, ctx) => {
		const state = await ensureWorktreeMetadata(pi, ctx);
		if (state.kind === "none") return;
		if (state.kind === "invalid") {
			ctx.ui.notify(`${state.error} The patch is stale or absent.`, "error");
			return;
		}
		try {
			await exportWorktreePatch(state.metadata);
			ctx.ui.notify(`Patch: ${state.metadata.patchPath}`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Patch export failed: ${message}\nThe patch is stale or absent: ${state.metadata.patchPath}`,
				"error",
			);
		}
	});
}

function registerDestroyCommand(pi: ExtensionAPI): void {
	pi.registerCommand("destroy", {
		description:
			"Delete the active worktree session and its checkout, but keep its patch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("destroy requires interactive mode", "error");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify(
					"Wait for the session to become idle without queued messages.",
					"error",
				);
				return;
			}
			const state = await ensureWorktreeMetadata(pi, ctx);
			if (state.kind !== "worktree") {
				ctx.ui.notify(
					state.kind === "invalid"
						? state.error
						: "destroy is available only in worktree sessions.",
					"error",
				);
				return;
			}
			const metadata = state.metadata;
			const activeFile = ctx.sessionManager.getSessionFile();
			if (activeFile === undefined) {
				ctx.ui.notify("The active session has no file to delete.", "error");
				return;
			}
			let ownsCleanup = false;
			try {
				const sessionFile = await realpath(activeFile);
				const parent = await getWorktreeParentSession(metadata);
				const parentFile = parent.file;
				for (const file of [
					sessionFile,
					parentFile,
					parent.ownerFile,
					await realpath(ctx.sessionManager.getSessionDir()),
				])
					assertSessionOutsideWorktree(metadata.worktreeRoot, file);
				if (sessionFile === parentFile)
					throw new Error("The active session is also the parent session.");
				if (
					!(await ctx.ui.confirm(
						"Destroy worktree session?",
						`Delete the checkout and all its files, including unintegrated changes and ignored files:\n${metadata.worktreeRoot}\nDelete only this session:\n${sessionFile}\nPreserve the final patch:\n${metadata.patchPath}`,
					))
				)
					return;
				if (!ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error(
						"The session is no longer idle without queued messages.",
					);
				if (cleanupHost[CLEANUP_KEY])
					throw new Error("Worktree cleanup is already active.");
				cleanupHost[CLEANUP_KEY] = {
					sessionId: ctx.sessionManager.getSessionId(),
					parentFile,
					allowParentSwitch: false,
				};
				ownsCleanup = true;
				await exportWorktreePatch(metadata);
				cleanupHost[CLEANUP_KEY].allowParentSwitch = true;
				const result = await ctx.switchSession(parentFile, {
					withSession: async (replacement) => {
						try {
							if (
								(await realpath(replacement.cwd)) !== parent.cwd ||
								replacement.sessionManager.getSessionFile() !== parentFile
							)
								throw new Error(
									"The replacement session differs from the parent session.",
								);
							await removeWorktree(metadata.worktreeRoot, metadata.parentRoot);
							await unlink(sessionFile);
							replacement.ui.notify(
								`Worktree and active session deleted. Patch preserved: ${metadata.patchPath}`,
								"info",
							);
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							replacement.ui.notify(
								`Cleanup failed: ${message}\nWorktree: ${metadata.worktreeRoot}\nSession: ${sessionFile}\nPatch preserved: ${metadata.patchPath}`,
								"error",
							);
						}
					},
				});
				if (result.cancelled)
					ctx.ui.notify(
						"Destroy cancelled. Worktree and session retained.",
						"info",
					);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const notice = `Destroy stopped: ${message}\nWorktree and session retained. Patch: ${metadata.patchPath}`;
				try {
					ctx.ui.notify(notice, "error");
				} catch {
					// Session replacement can invalidate ctx before a failure returns.
					console.error(notice);
				}
			} finally {
				if (ownsCleanup) delete cleanupHost[CLEANUP_KEY];
			}
		},
	});
}

export default function worktree(pi: ExtensionAPI): void {
	registerPatchLifecycle(pi);
	pi.registerCommand("worktree", {
		description: "Transfer context to a new session in an isolated worktree",
		handler: async (args, ctx) => {
			if (await blockWorktreeSessionCreation(pi, ctx)) return;
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
			if (generated === null) return;
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
				const message = error instanceof Error ? error.message : String(error);
				const notice = `${message}\nRetained worktree: ${result.root}`;
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
