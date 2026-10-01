import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
} from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createSnapshot } from "../snapshot";
import { formatGitFailure, runGit } from "./git";
import { preparePatchDirectory } from "./worktree-patch";

const WORKTREE_DIRECTORY = path.resolve(getAgentDir(), "worktrees");
const INCLUDE_FILE = ".worktreeinclude";

type WorktreeResult =
	| {
			readonly ok: true;
			readonly root: string;
			readonly parentRoot: string;
			readonly baseCommit: string;
	  }
	| { readonly ok: false; readonly error: string };

async function git(args: readonly string[], cwd: string): Promise<string> {
	const result = await runGit(args, cwd);
	if (result.exitCode !== 0) {
		throw new Error(formatGitFailure(args.join(" "), result));
	}
	return result.stdout.trim();
}

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

function isReserved(relative: string): boolean {
	return relative.split(path.sep).some((part) => part.toLowerCase() === ".git");
}

async function readIncludes(root: string): Promise<string[]> {
	const manifest = path.join(root, INCLUDE_FILE);
	try {
		await lstat(manifest);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const resolvedManifest = await realpath(manifest);
	if (
		!isWithin(root, resolvedManifest) ||
		isReserved(path.relative(root, resolvedManifest))
	) {
		throw new Error("The include manifest escapes the source checkout.");
	}
	const text = await readFile(resolvedManifest, "utf8");
	const entries: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (line === "") continue;
		const entry = line.endsWith("/") ? line.slice(0, -1) : line;
		const parts = entry.split("/");
		if (
			line !== line.trim() ||
			path.isAbsolute(line) ||
			line.includes("\0") ||
			/[*?[\]{}\\]/.test(line) ||
			parts.some((part) => part === "" || part === "." || part === "..") ||
			isReserved(line)
		) {
			throw new Error(
				`Invalid path in ${INCLUDE_FILE}: ${JSON.stringify(line)}`,
			);
		}
		const source = await realpath(path.join(root, entry));
		if (!isWithin(root, source) || isReserved(path.relative(root, source))) {
			throw new Error(`Path escapes the source checkout: ${line}`);
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
	return directory;
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
				const resolved = await realpath(ancestor);
				if (
					!isWithin(targetRoot, resolved) ||
					isReserved(path.relative(targetRoot, resolved))
				) {
					throw new Error(`Destination escapes the worktree: ${entry}`);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				// A dangling symlink is not a missing directory.
				try {
					await lstat(ancestor);
					throw new Error(
						`Destination contains a dangling symbolic link: ${entry}`,
					);
				} catch (statError) {
					if ((statError as NodeJS.ErrnoException).code !== "ENOENT")
						throw statError;
				}
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

async function validateSnapshotLinks(
	root: string,
	commit: string,
): Promise<void> {
	const tree = await git(["ls-tree", "-r", "-z", commit], root);
	for (const record of tree.split("\0")) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		const [mode, , object] = record.slice(0, tab).split(" ");
		if (mode !== "120000") continue;
		const name = record.slice(tab + 1);
		const link = await runGit(["cat-file", "blob", object], root);
		if (link.exitCode !== 0)
			throw new Error(formatGitFailure("cat-file", link));
		const target = path.resolve(root, path.dirname(name), link.stdout);
		if (
			path.isAbsolute(link.stdout) ||
			!isWithin(root, target) ||
			isReserved(path.relative(root, target))
		) {
			throw new Error(
				`Tracked symbolic link cannot enter an isolated worktree: ${name}`,
			);
		}
		try {
			const resolved = await realpath(path.join(root, name));
			if (
				!isWithin(root, resolved) ||
				isReserved(path.relative(root, resolved))
			) {
				throw new Error(
					`Tracked symbolic link escapes the source checkout: ${name}`,
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export async function removeWorktree(
	root: string,
	parentRoot: string,
): Promise<void> {
	await git(["worktree", "remove", "--force", root], parentRoot);
}

/** Retain a worktree after failure so the user can inspect or remove it. */
export async function createWorktree(cwd: string): Promise<WorktreeResult> {
	let target: string | null = null;
	try {
		const sourceRoot = await realpath(
			await git(["rev-parse", "--show-toplevel"], cwd),
		);
		const entries = await readIncludes(sourceRoot);
		const directory = await prepareDirectory(sourceRoot);
		await preparePatchDirectory(sourceRoot);
		const snapshot = await createSnapshot(sourceRoot, "worktree handoff");
		if (!snapshot.ok) return snapshot;
		await validateSnapshotLinks(sourceRoot, snapshot.snapshot.commit);
		target = await mkdtemp(`${directory}${path.sep}`);
		await git(
			["worktree", "add", "--detach", target, snapshot.snapshot.commit],
			sourceRoot,
		);
		await copyIncludes(sourceRoot, target, entries);
		return {
			ok: true,
			root: target,
			parentRoot: sourceRoot,
			baseCommit: snapshot.snapshot.commit,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `${message}${target === null ? "" : `\nRetained worktree path: ${target}`}`,
		};
	}
}
