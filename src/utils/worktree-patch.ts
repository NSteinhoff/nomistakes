import { randomUUID } from "node:crypto";
import {
	appendFile,
	mkdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { createSnapshot } from "../snapshot";
import { formatGitFailure, runGit, runGitBytes } from "./git";

export const WORKTREE_METADATA_TYPE = "worktree-session";
const PATCH_DIRECTORY = ".patches";

export type WorktreeMetadata = {
	readonly worktreeRoot: string;
	readonly parentRoot: string;
	readonly baseCommit: string;
	readonly patchPath: string;
};

type WorktreeState =
	| { readonly kind: "none" }
	| { readonly kind: "invalid"; readonly error: string }
	| { readonly kind: "worktree"; readonly metadata: WorktreeMetadata };

export function createWorktreeMetadata(options: {
	readonly worktreeRoot: string;
	readonly parentRoot: string;
	readonly baseCommit: string;
	readonly sessionId: string;
}): WorktreeMetadata {
	return {
		worktreeRoot: options.worktreeRoot,
		parentRoot: options.parentRoot,
		baseCommit: options.baseCommit,
		patchPath: path.join(
			options.parentRoot,
			PATCH_DIRECTORY,
			`${options.sessionId}.patch`,
		),
	};
}

function isMetadata(value: unknown): value is WorktreeMetadata {
	return (
		typeof value === "object" &&
		value !== null &&
		"worktreeRoot" in value &&
		typeof value.worktreeRoot === "string" &&
		"parentRoot" in value &&
		typeof value.parentRoot === "string" &&
		"baseCommit" in value &&
		typeof value.baseCommit === "string" &&
		"patchPath" in value &&
		typeof value.patchPath === "string"
	);
}

function getWorktreeState(
	cwd: string,
	sessionEntries: readonly SessionEntry[],
): WorktreeState {
	const entries = sessionEntries.filter(
		(entry) =>
			entry.type === "custom" && entry.customType === WORKTREE_METADATA_TYPE,
	);
	if (entries.length === 0) return { kind: "none" };
	const entry = entries[0];
	if (
		entries.length !== 1 ||
		entry.type !== "custom" ||
		!isMetadata(entry.data)
	) {
		return { kind: "invalid", error: "Invalid worktree session metadata." };
	}
	const metadata = entry.data;
	const expectedPath = path.join(
		metadata.parentRoot,
		PATCH_DIRECTORY,
		path.basename(metadata.patchPath),
	);
	if (
		!path.isAbsolute(metadata.worktreeRoot) ||
		!path.isAbsolute(metadata.parentRoot) ||
		metadata.worktreeRoot === metadata.parentRoot ||
		!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(metadata.baseCommit) ||
		metadata.patchPath !== expectedPath ||
		!/^[a-f0-9-]+\.patch$/.test(path.basename(metadata.patchPath))
	) {
		return { kind: "invalid", error: "Invalid worktree session metadata." };
	}
	if (path.resolve(cwd) !== metadata.worktreeRoot) {
		return {
			kind: "invalid",
			error: "The session CWD differs from its worktree path.",
		};
	}
	return { kind: "worktree", metadata };
}

async function git(args: readonly string[], cwd: string): Promise<string> {
	const result = await runGit(args, cwd);
	if (result.exitCode !== 0)
		throw new Error(formatGitFailure(args.join(" "), result));
	return result.stdout.trim();
}

export async function preparePatchDirectory(
	parentRoot: string,
): Promise<string> {
	if ((await realpath(parentRoot)) !== parentRoot)
		throw new Error(
			"The parent checkout path differs from its canonical path.",
		);
	if (await git(["ls-files", "--", PATCH_DIRECTORY], parentRoot)) {
		throw new Error("The patch directory contains tracked files.");
	}
	const directory = path.join(parentRoot, PATCH_DIRECTORY);
	await mkdir(directory, { recursive: true });
	if ((await realpath(directory)) !== directory)
		throw new Error("The patch directory must not be a symbolic link.");
	const exclude = path.resolve(
		parentRoot,
		await git(["rev-parse", "--git-path", "info/exclude"], parentRoot),
	);
	await mkdir(path.dirname(exclude), { recursive: true });
	let text = "";
	try {
		text = await readFile(exclude, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const rule = `/${PATCH_DIRECTORY}/`;
	if (!text.split(/\r?\n/).includes(rule))
		await appendFile(exclude, `\n${rule}\n`);
	const ignored = await runGit(
		["check-ignore", "--quiet", "--", `${PATCH_DIRECTORY}/`],
		parentRoot,
	);
	if (ignored.exitCode !== 0)
		throw new Error(
			"Git does not ignore the patch directory. Check the parent checkout's ignore rules.",
		);
	return directory;
}

async function writeAtomicPatch(
	file: string,
	content: string | Buffer,
): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function ownerPath(cwd: string): Promise<string | null> {
	const result = await runGit(
		["rev-parse", "--git-path", WORKTREE_METADATA_TYPE],
		cwd,
	);
	return result.exitCode === 0 ? path.resolve(cwd, result.stdout.trim()) : null;
}

/** A checkout reference preserves identity across new sessions in the same worktree. */
export async function registerWorktreeOwner(
	root: string,
	sessionFile: string,
): Promise<void> {
	const file = await ownerPath(root);
	if (file === null)
		throw new Error("Cannot locate the worktree's Git metadata.");
	await writeAtomicPatch(file, JSON.stringify(sessionFile));
}

export async function ensureWorktreeMetadata(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<WorktreeState> {
	const state = getWorktreeState(ctx.cwd, ctx.sessionManager.getEntries());
	if (state.kind !== "none") return state;
	try {
		const file = await ownerPath(ctx.cwd);
		if (file === null) return state;
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return state;
			throw error;
		}
		const sessionFile: unknown = JSON.parse(text);
		if (typeof sessionFile !== "string" || !path.isAbsolute(sessionFile)) {
			throw new Error("Invalid worktree owner reference.");
		}
		const entries = parseSessionEntries(
			await readFile(sessionFile, "utf8"),
		).filter((entry) => entry.type !== "session");
		const inherited = getWorktreeState(ctx.cwd, entries);
		if (inherited.kind === "none")
			throw new Error("The worktree owner lacks session metadata.");
		if (inherited.kind === "worktree")
			pi.appendEntry(WORKTREE_METADATA_TYPE, inherited.metadata);
		return inherited;
	} catch (error) {
		return {
			kind: "invalid",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function getWorktreeParentSession(
	metadata: WorktreeMetadata,
): Promise<{
	readonly file: string;
	readonly cwd: string;
	readonly ownerFile: string;
}> {
	const file = await ownerPath(metadata.worktreeRoot);
	if (file === null) throw new Error("Cannot locate the worktree owner.");
	const owner: unknown = JSON.parse(await readFile(file, "utf8"));
	if (typeof owner !== "string" || !path.isAbsolute(owner))
		throw new Error("Invalid worktree owner reference.");
	const header = parseSessionEntries(await readFile(owner, "utf8")).find(
		(entry) => entry.type === "session",
	);
	const parent = header?.parentSession;
	if (!parent || !path.isAbsolute(parent))
		throw new Error("The worktree owner lacks a parent session.");
	const parentFile = await realpath(parent);
	const parentHeader = parseSessionEntries(
		await readFile(parentFile, "utf8"),
	).find((entry) => entry.type === "session");
	if (
		!parentHeader ||
		(await realpath(
			await git(["rev-parse", "--show-toplevel"], parentHeader.cwd),
		)) !== metadata.parentRoot
	)
		throw new Error("The parent session CWD differs from the parent checkout.");
	return {
		file: parentFile,
		cwd: await realpath(parentHeader.cwd),
		ownerFile: await realpath(owner),
	};
}

export async function blockWorktreeSessionCreation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<boolean> {
	const state = await ensureWorktreeMetadata(pi, ctx);
	if (state.kind === "none") return false;
	ctx.ui.notify(
		state.kind === "invalid"
			? `${state.error} Session creation is blocked.`
			: "Session creation is blocked in worktree sessions.",
		"error",
	);
	return true;
}

/** Preserve the previous patch if capture or export fails. */
export async function exportWorktreePatch(
	metadata: WorktreeMetadata,
): Promise<void> {
	const parentCommon = await realpath(
		path.resolve(
			metadata.parentRoot,
			await git(["rev-parse", "--git-common-dir"], metadata.parentRoot),
		),
	);
	const worktreeCommon = await realpath(
		path.resolve(
			metadata.worktreeRoot,
			await git(["rev-parse", "--git-common-dir"], metadata.worktreeRoot),
		),
	);
	if (parentCommon !== worktreeCommon)
		throw new Error(
			"The parent checkout and worktree belong to different repositories.",
		);
	if ((await realpath(metadata.worktreeRoot)) !== metadata.worktreeRoot)
		throw new Error("The worktree path differs from its canonical path.");
	await preparePatchDirectory(metadata.parentRoot);
	// An aborted turn still exports its partial edits, without its aborted signal.
	const snapshot = await createSnapshot(
		metadata.worktreeRoot,
		"worktree patch export",
	);
	if (!snapshot.ok) throw new Error(snapshot.error);
	if (snapshot.snapshot.repoRoot !== metadata.worktreeRoot)
		throw new Error("The session directory is not the worktree root.");
	const patch = await runGitBytes(
		[
			"diff",
			"--binary",
			"--full-index",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--no-relative",
			"--ignore-submodules=none",
			"--submodule=short",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			metadata.baseCommit,
			snapshot.snapshot.commit,
			"--",
		],
		metadata.worktreeRoot,
	);
	if (patch.exitCode !== 0)
		throw new Error(
			formatGitFailure("diff --binary", {
				...patch,
				stdout: patch.stdout.toString("utf8"),
			}),
		);
	await writeAtomicPatch(metadata.patchPath, patch.stdout);
}
