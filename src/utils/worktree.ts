import { randomUUID } from "node:crypto";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./error-message";
import {
	formatGitFailure,
	gitAddExcludeRule,
	gitOutput,
	runGitBytes,
} from "./git";
import { createSnapshot } from "./snapshot";

export const WORKTREE_METADATA_TYPE = "worktree-session";

const WORKTREE_DIRECTORY = path.resolve(getAgentDir(), "worktrees");
const INCLUDE_FILE = ".worktreeinclude";
const PATCH_DIRECTORY = ".patches";

export type WorktreeMetadata = {
	readonly worktreeRoot: string;
	readonly parentRoot: string;
	readonly baseCommit: string;
	readonly patchPath: string;
};

export type WorktreeState =
	| { readonly kind: "none" }
	| { readonly kind: "invalid"; readonly error: string }
	| { readonly kind: "worktree"; readonly metadata: WorktreeMetadata };

type WorktreeResult =
	| {
			readonly ok: true;
			readonly root: string;
			readonly parentRoot: string;
			readonly baseCommit: string;
	  }
	| { readonly ok: false; readonly error: string };

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);

	if (relative === "") {
		return true;
	}

	if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
		return false;
	}

	return !path.isAbsolute(relative);
}

function isReserved(relative: string): boolean {
	const parts = relative.split(path.sep);
	for (const part of parts) {
		switch (part.toLowerCase()) {
			case ".git":
				return true;
		}
	}

	return false;
}

async function resolveLocalPath(
	root: string,
	relativePath: string,
): Promise<string | null> {
	const file = path.join(root, relativePath);

	try {
		await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null; // File does not exist
		}
		throw error; // Cannot inspect file
	}

	const resolved = await realpath(file);

	if (!isWithin(root, resolved)) {
		throw new Error("The path escapes the checkout.");
	}

	if (isReserved(path.relative(root, resolved))) {
		throw new Error("The path points to a reserved file.");
	}

	return resolved;
}

function isValidIncludeEntry(entry: string): boolean {
	if (entry !== entry.trim()) return false;
	if (path.isAbsolute(entry)) return false;
	if (entry.includes("\0")) return false;
	if (/[*?[\]{}\\]/.test(entry)) return false; // Reject glob patterns

	const parts = entry.split("/");
	for (const part of parts) {
		switch (part) {
			case "":
			case ".":
			case "..":
				return false;
		}
	}

	return true;
}

function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

async function readIncludes(root: string): Promise<string[]> {
	const manifest = await resolveLocalPath(root, INCLUDE_FILE);
	if (manifest === null) {
		return [];
	}

	const text = await readFile(manifest, "utf8");

	const entries: string[] = [];
	for (const line of splitLines(text)) {
		const entry = line.endsWith("/") ? line.slice(0, -1) : line;
		if (entry === "") {
			continue;
		}

		if (
			!isValidIncludeEntry(entry) ||
			(await resolveLocalPath(root, entry)) === null
		) {
			throw new Error(
				`Invalid path in ${INCLUDE_FILE}: ${JSON.stringify(line)}`,
			);
		}
		entries.push(entry);
	}

	return entries;
}

async function prepareDirectory(root: string): Promise<string> {
	await mkdir(WORKTREE_DIRECTORY, { recursive: true });
	const directory = await realpath(WORKTREE_DIRECTORY);

	if (isWithin(root, directory)) {
		throw new Error(
			"The worktree directory must reside outside the source checkout.",
		);
	}

	const target = await mkdtemp(`${directory}${path.sep}`);

	return target;
}

async function copyIncludes(
	sourceRoot: string,
	targetRoot: string,
	entries: readonly string[],
): Promise<void> {
	for (const entry of entries) {
		const target = path.join(targetRoot, entry);

		// An existing ancestor can be a tracked symlink into another checkout.
		let ancestor = path.dirname(target);

		while (ancestor !== targetRoot) {
			try {
				await resolveLocalPath(targetRoot, path.relative(targetRoot, ancestor));
			} catch (error) {
				throw new Error(
					`Invalid destination for ${entry}: ${errorMessage(error)}`,
				);
			}

			ancestor = path.dirname(ancestor);
		}

		await rm(target, { recursive: true, force: true });
		await mkdir(path.dirname(target), { recursive: true });

		await cp(path.join(sourceRoot, entry), target, {
			recursive: true,
			dereference: true,
			filter: async (source) => {
				const resolved = await realpath(source);
				if (
					!isWithin(sourceRoot, resolved) ||
					isReserved(path.relative(sourceRoot, source)) ||
					isReserved(path.relative(sourceRoot, resolved))
				) {
					throw new Error(
						`Included content escapes the source checkout: ${source}`,
					);
				}
				return true;
			},
		});
	}
}

/** Retain a worktree after failure so the user can inspect or remove it. */
export async function createWorktree(cwd: string): Promise<WorktreeResult> {
	let target: string | null = null;
	try {
		const sourceRoot = await realpath(
			await gitOutput(["rev-parse", "--show-toplevel"], cwd),
		);

		await preparePatchDirectory(sourceRoot);

		const snapshot = await createSnapshot({
			cwd: sourceRoot,
			description: "worktree handoff",
		});
		if (!snapshot.ok) {
			return snapshot;
		}

		target = await prepareDirectory(sourceRoot);

		await gitOutput(
			["worktree", "add", "--detach", target, snapshot.snapshot.commit],
			sourceRoot,
		);

		const entries = await readIncludes(sourceRoot);
		await copyIncludes(sourceRoot, target, entries);

		return {
			ok: true,
			root: target,
			parentRoot: sourceRoot,
			baseCommit: snapshot.snapshot.commit,
		};
	} catch (error) {
		const message = errorMessage(error);
		return {
			ok: false,
			error: `${message}${target === null ? "" : `\nRetained worktree path: ${target}`}`,
		};
	}
}

export function createWorktreeMetadata({
	worktreeRoot,
	parentRoot,
	baseCommit,
	sessionId,
}: {
	readonly worktreeRoot: string;
	readonly parentRoot: string;
	readonly baseCommit: string;
	readonly sessionId: string;
}): WorktreeMetadata {
	return {
		worktreeRoot: worktreeRoot,
		parentRoot: parentRoot,
		baseCommit: baseCommit,
		patchPath: path.join(parentRoot, PATCH_DIRECTORY, `${sessionId}.patch`),
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

export function getWorktreeState(
	cwd: string,
	sessionEntries: readonly SessionEntry[],
): WorktreeState {
	const [entry, ...more] = sessionEntries.filter(
		(entry) =>
			entry.type === "custom" && entry.customType === WORKTREE_METADATA_TYPE,
	);

	if (!entry) {
		return { kind: "none" };
	}

	if (more.length > 0) {
		return { kind: "invalid", error: "Duplicate worktree session metadata." };
	}

	if (entry.type !== "custom" || !isMetadata(entry.data)) {
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

async function preparePatchDirectory(parentRoot: string): Promise<void> {
	if ((await realpath(parentRoot)) !== parentRoot) {
		throw new Error(
			"The parent checkout path differs from its canonical path.",
		);
	}

	if (await gitOutput(["ls-files", "--", PATCH_DIRECTORY], parentRoot)) {
		throw new Error("The patch directory contains tracked files.");
	}

	const directory = path.join(parentRoot, PATCH_DIRECTORY);
	await mkdir(directory, { recursive: true });

	if ((await realpath(directory)) !== directory) {
		throw new Error("The patch directory must not be a symbolic link.");
	}

	await gitAddExcludeRule(`/${PATCH_DIRECTORY}/`, parentRoot);
}

async function writeFileAtomic(
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

async function resolveGitCommonDirectory(cwd: string): Promise<string> {
	return await realpath(
		path.resolve(cwd, await gitOutput(["rev-parse", "--git-common-dir"], cwd)),
	);
}

/** Preserve the previous patch if capture or export fails. */
export async function exportWorktreePatch(
	metadata: WorktreeMetadata,
): Promise<void> {
	const parentCommon = await resolveGitCommonDirectory(metadata.parentRoot);
	const worktreeCommon = await resolveGitCommonDirectory(metadata.worktreeRoot);

	if (parentCommon !== worktreeCommon) {
		throw new Error(
			"The parent checkout and worktree belong to different repositories.",
		);
	}

	if ((await realpath(metadata.worktreeRoot)) !== metadata.worktreeRoot) {
		throw new Error("The worktree path differs from its canonical path.");
	}

	await preparePatchDirectory(metadata.parentRoot);

	// An aborted turn still exports its partial edits, without its aborted signal.
	const snapshot = await createSnapshot({
		cwd: metadata.worktreeRoot,
		description: "worktree patch export",
	});

	if (!snapshot.ok) {
		throw new Error(snapshot.error);
	}

	if (snapshot.snapshot.repoRoot !== metadata.worktreeRoot) {
		throw new Error("The session directory is not the worktree root.");
	}

	const patch = await runGitBytes({
		args: [
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
		cwd: metadata.worktreeRoot,
	});

	if (patch.exitCode !== 0) {
		throw new Error(
			formatGitFailure("diff --binary", {
				...patch,
				stdout: patch.stdout.toString("utf8"),
			}),
		);
	}

	await writeFileAtomic(metadata.patchPath, patch.stdout);
}
