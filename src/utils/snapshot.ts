import { copyFile, lstat, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { errorMessage } from "./error-message";
import { formatGitFailure, type GitResult, runGit, runGitBytes } from "./git";

// Deterministic identity so snapshot creation never depends on the repo's
// configured user.name/user.email; commit-tree otherwise fails when no
// committer identity is set.
const SNAPSHOT_IDENTITY: Readonly<Record<string, string>> = {
	GIT_AUTHOR_NAME: "pi snapshot",
	GIT_AUTHOR_EMAIL: "pi-snapshot@localhost",
	GIT_COMMITTER_NAME: "pi snapshot",
	GIT_COMMITTER_EMAIL: "pi-snapshot@localhost",
};

export type Snapshot = {
	readonly id: string;
	readonly commit: string;
	readonly tree: string;
	readonly repoRoot: string;
	readonly createdAt: number;
	readonly description: string;
};

export type SnapshotResult =
	| { readonly ok: true; readonly snapshot: Snapshot }
	| { readonly ok: false; readonly error: string };

/** Capture Git-visible content without changes to the checkout or its index. */
export async function createSnapshot({
	cwd,
	description,
	signal,
}: {
	cwd: string;
	description: string;
	signal?: AbortSignal;
}): Promise<SnapshotResult> {
	try {
		const repoRootResult = await runGit({
			args: ["rev-parse", "--show-toplevel"],
			cwd,
			signal,
		});
		if (repoRootResult.exitCode !== 0) {
			return {
				ok: false,
				error: `Cannot create turn snapshot outside a Git worktree. ${formatGitFailure("rev-parse --show-toplevel", repoRootResult)}`,
			};
		}
		const repoRoot = repoRootResult.stdout.trim();
		const realIndexPathResult = await runGit({
			args: ["rev-parse", "--git-path", "index"],
			cwd: repoRoot,
			signal,
		});
		if (realIndexPathResult.exitCode !== 0) {
			return {
				ok: false,
				error: formatGitFailure(
					"rev-parse --git-path index",
					realIndexPathResult,
				),
			};
		}
		const realIndexPath = path.resolve(
			repoRoot,
			realIndexPathResult.stdout.trim(),
		);
		return await withTempIndexDir((tempIndexPath) =>
			buildSnapshotCommit({
				repoRoot,
				realIndexPath,
				tempIndexPath,
				description,
				signal,
			}),
		);
	} catch (error) {
		return {
			ok: false,
			error: `Failed to create turn snapshot: ${errorMessage(error)}`,
		};
	}
}

async function buildSnapshotCommit({
	repoRoot,
	realIndexPath,
	tempIndexPath,
	description,
	signal,
}: {
	repoRoot: string;
	realIndexPath: string;
	tempIndexPath: string;
	description: string;
	signal?: AbortSignal;
}): Promise<SnapshotResult> {
	if (await fileExists(realIndexPath)) {
		await copyFile(realIndexPath, tempIndexPath);
	} else {
		const emptyResult = await gitWithTempIndex(
			["read-tree", "--empty"],
			repoRoot,
			tempIndexPath,
			signal,
		);
		if (emptyResult.exitCode !== 0) {
			return {
				ok: false,
				error: formatGitFailure("read-tree --empty", emptyResult),
			};
		}
	}

	const refreshResult = await refreshSnapshotIndex(
		repoRoot,
		tempIndexPath,
		signal,
	);
	if (refreshResult.exitCode !== 0) {
		return {
			ok: false,
			error: formatGitFailure("update-index", refreshResult),
		};
	}

	// Respect Git ignore rules: include tracked files and non-ignored untracked
	// files while leaving ignored files outside the snapshot.
	const addResult = await gitWithTempIndex(
		["add", "--sparse", "-A"],
		repoRoot,
		tempIndexPath,
		signal,
	);
	if (addResult.exitCode !== 0) {
		return { ok: false, error: formatGitFailure("add --sparse -A", addResult) };
	}

	const treeResult = await gitWithTempIndex(
		["write-tree"],
		repoRoot,
		tempIndexPath,
		signal,
	);
	if (treeResult.exitCode !== 0) {
		return { ok: false, error: formatGitFailure("write-tree", treeResult) };
	}
	const tree = treeResult.stdout.trim();
	const headResult = await runGit({
		args: ["rev-parse", "--verify", "HEAD"],
		cwd: repoRoot,
		signal,
	});
	const commitArgs = ["commit-tree", tree];
	if (headResult.exitCode === 0) {
		commitArgs.push("-p", headResult.stdout.trim());
	}
	const commitResult = await runGit({
		args: commitArgs,
		cwd: repoRoot,
		signal,
		env: SNAPSHOT_IDENTITY,
		input: "pi turn snapshot\n",
	});
	if (commitResult.exitCode !== 0) {
		return {
			ok: false,
			error: formatGitFailure("commit-tree", commitResult),
		};
	}
	const commit = commitResult.stdout.trim();
	return {
		ok: true,
		snapshot: {
			id: commit.slice(0, 12),
			commit,
			tree,
			repoRoot,
			createdAt: Date.now(),
			description,
		},
	};
}

export async function gitWithTempIndex(
	args: readonly string[],
	cwd: string,
	tempIndexPath: string,
	signal?: AbortSignal,
): Promise<GitResult> {
	return await runGit({
		args,
		cwd,
		signal,
		env: {
			GIT_INDEX_FILE: tempIndexPath,
		},
	});
}

// Owns the temporary index directory lifecycle so callers stay free of a nested
// try/finally: the directory is always removed once `fn` settles.
async function withTempIndexDir<T>(
	fn: (tempIndexPath: string) => Promise<T>,
): Promise<T> {
	const tempDir = await makeTempSnapshotDir();
	try {
		return await fn(path.join(tempDir, "index"));
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function makeTempSnapshotDir(): Promise<string> {
	const root = path.join(tmpdir(), "pi-snapshot-");
	await mkdir(tmpdir(), { recursive: true });
	return await mkdtemp(root);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stats = await stat(filePath);
		return stats.isFile();
	} catch {
		return false;
	}
}

async function refreshSnapshotIndex(
	cwd: string,
	tempIndexPath: string,
	signal?: AbortSignal,
): Promise<GitResult> {
	const env = { GIT_INDEX_FILE: tempIndexPath };
	const files = await runGitBytes({
		args: ["ls-files", "--stage", "-z"],
		cwd,
		signal,
		env,
	});
	if (files.exitCode !== 0)
		return { ...files, stdout: files.stdout.toString("utf8") };
	const names: Buffer[] = [];
	const presentNames: Buffer[] = [];
	const separator = Buffer.from("\0");
	const prefix = Buffer.from(`${cwd}${path.sep}`);
	for (let start = 0; start < files.stdout.length; ) {
		const end = files.stdout.indexOf(0, start);
		if (end < 0) throw new Error("Invalid index path list from Git.");
		const record = files.stdout.subarray(start, end);
		start = end + 1;
		const tab = record.indexOf(9);
		// Unmerged entries lack stage zero. The later add resolves the private index.
		if (tab < 0 || !record.subarray(0, tab).toString("ascii").endsWith(" 0"))
			continue;
		const name = record.subarray(tab + 1);
		const indexedName = Buffer.concat([name, separator]);
		names.push(indexedName);
		try {
			await lstat(Buffer.concat([prefix, name]));
			presentNames.push(indexedName);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
		}
	}
	if (names.length === 0) return { ...files, stdout: "" };
	// Source index hints must not suppress local content in the private capture.
	const assumeResult = await runGit({
		args: ["update-index", "--no-assume-unchanged", "-z", "--stdin"],
		cwd,
		signal,
		env,
		input: Buffer.concat(names),
	});
	if (assumeResult.exitCode !== 0 || presentNames.length === 0)
		return assumeResult;
	// Absent sparse paths remain indexed. Present paths contribute their local content.
	return runGit({
		args: ["update-index", "--no-skip-worktree", "-z", "--stdin"],
		cwd,
		signal,
		env,
		input: Buffer.concat(presentNames),
	});
}
