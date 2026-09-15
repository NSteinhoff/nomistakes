/**
 * Tracks created and deleted paths in Git's index without exposing Git itself.
 *
 * Invariants:
 * - Only repository-relative file paths are accepted.
 * - New files use intent-to-add, so their content is not staged.
 * - Deleted tracked files are staged as deletions; tracked modifications are untouched.
 * - Repeating any tracking action has no additional effect.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatGitFailure, runGit } from "./utils/git";

type PathState = "new" | "deleted" | "staged-deleted" | "tracked";

type TrackedPath = {
	readonly path: string;
	readonly state: PathState;
};

type ToolDetails = {
	readonly added: readonly string[];
	readonly deleted: readonly string[];
	readonly unchanged: readonly string[];
};

const parameters = Type.Object({
	paths: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		description:
			"Created or deleted repository-relative file paths to make visible to index-aware build commands.",
	}),
});

const DESCRIPTION = [
	"Track created and deleted files in the Git index idempotently.",
	"Tracked files that still exist are unchanged, so this tool never stages modifications.",
	"Use this before an index-sensitive build needs created or deleted files. Do not alter build commands to work around a stale index.",
].join(" ");

export default function gitIndexTrack(pi: ExtensionAPI): void {
	pi.registerTool<typeof parameters, ToolDetails>({
		name: "git_index_track",
		label: "Track Git Index Paths",
		description: DESCRIPTION,
		promptSnippet:
			"Make created or deleted paths visible to index-sensitive build commands.",
		promptGuidelines: [
			"Use git_index_track before an index-sensitive build requires created or deleted files; do not modify the build command to compensate for a stale Git index.",
		],
		parameters,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) =>
			await execute(params.paths, ctx, signal),
	});
}

async function execute(
	inputPaths: readonly string[],
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<ToolDetails>> {
	const repoRootResult = await runGit(
		["rev-parse", "--show-toplevel"],
		ctx.cwd,
		signal,
	);
	if (repoRootResult.exitCode !== 0) {
		return result(
			`Cannot track paths outside a Git worktree. ${formatGitFailure("rev-parse --show-toplevel", repoRootResult)}`,
		);
	}
	const repoRoot = repoRootResult.stdout.trim();
	const paths = normalizePaths(inputPaths, repoRoot);
	if (typeof paths === "string") return result(paths);

	const trackedPaths = await Promise.all(
		paths.map((candidate) => classifyPath(candidate, repoRoot, signal)),
	);
	for (const trackedPath of trackedPaths) {
		if (typeof trackedPath === "string") return result(trackedPath);
	}

	const added: string[] = [];
	const deleted: string[] = [];
	const deletionsToStage: string[] = [];
	const stagedDeleted: string[] = [];
	const unchanged: string[] = [];
	for (const candidate of trackedPaths) {
		if (typeof candidate === "string") continue;
		switch (candidate.state) {
			case "new":
				added.push(candidate.path);
				break;
			case "deleted":
				deleted.push(candidate.path);
				deletionsToStage.push(candidate.path);
				break;
			case "staged-deleted":
				deleted.push(candidate.path);
				stagedDeleted.push(candidate.path);
				break;
			case "tracked":
				unchanged.push(candidate.path);
				break;
			default: {
				const _state: never = candidate.state;
				return result(`Unsupported path state '${_state}'.`);
			}
		}
	}

	if (added.length > 0) {
		const addResult = await runGit(
			["add", "-N", "--", ...added],
			repoRoot,
			signal,
		);
		if (addResult.exitCode !== 0) {
			return result(formatGitFailure("add -N", addResult), {
				added: [],
				deleted: [],
				unchanged,
			});
		}
	}
	if (deletionsToStage.length > 0) {
		const deleteResult = await runGit(
			["add", "-u", "--", ...deletionsToStage],
			repoRoot,
			signal,
		);
		if (deleteResult.exitCode !== 0) {
			return result(formatGitFailure("add -u", deleteResult), {
				added,
				deleted: stagedDeleted,
				unchanged,
			});
		}
	}

	return result(
		[
			"Git index tracking complete.",
			formatPaths("Intent-to-add", added),
			formatPaths("Staged deletions", deleted),
			formatPaths("Unchanged tracked files", unchanged),
		].join("\n"),
		{ added, deleted, unchanged },
	);
}

function normalizePaths(
	inputPaths: readonly string[],
	repoRoot: string,
): readonly string[] | string {
	const paths = new Set<string>();
	for (const inputPath of inputPaths) {
		const trimmed = inputPath.trim();
		if (!trimmed) return "Invalid path: paths cannot be empty.";
		if (path.isAbsolute(trimmed)) {
			return `Invalid path '${inputPath}': paths must be repository-relative.`;
		}
		if (trimmed.split(/[\\/]/).some((part) => part === "..")) {
			return `Invalid path '${inputPath}': parent-directory traversal is not allowed.`;
		}
		if (trimmed.split(/[\\/]/).some((part) => part === ".git")) {
			return `Invalid path '${inputPath}': Git metadata paths are not allowed.`;
		}

		const resolved = path.resolve(repoRoot, trimmed);
		const relative = path.relative(repoRoot, resolved);
		if (
			relative === "" ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			return `Invalid path '${inputPath}': path resolves outside the repository.`;
		}
		paths.add(relative);
	}
	return [...paths];
}

async function classifyPath(
	candidate: string,
	repoRoot: string,
	signal?: AbortSignal,
): Promise<TrackedPath | string> {
	const filePath = path.join(repoRoot, candidate);
	const exists = await pathExists(filePath);
	if (typeof exists === "string") return exists;
	if (exists) {
		try {
			const stats = await lstat(filePath);
			if (stats.isDirectory()) {
				return `Invalid path '${candidate}': directories are not supported.`;
			}
		} catch (error) {
			return `Cannot inspect '${candidate}': ${errorMessage(error)}`;
		}
	}

	const trackedResult = await runGit(
		["ls-files", "--error-unmatch", "--", candidate],
		repoRoot,
		signal,
	);
	if (trackedResult.exitCode === 0) {
		return { path: candidate, state: exists ? "tracked" : "deleted" };
	}
	if (trackedResult.exitCode !== 1) {
		return formatGitFailure("ls-files --error-unmatch", trackedResult);
	}
	if (!exists) {
		const stagedDeletionResult = await runGit(
			[
				"diff",
				"--cached",
				"--no-renames",
				"--name-only",
				"--diff-filter=D",
				"-z",
				"--",
				candidate,
			],
			repoRoot,
			signal,
		);
		if (stagedDeletionResult.exitCode !== 0) {
			return formatGitFailure("diff --cached", stagedDeletionResult);
		}
		if (stagedDeletionResult.stdout.split("\0").includes(candidate)) {
			return { path: candidate, state: "staged-deleted" };
		}
		return `Cannot track '${candidate}': the path does not exist and is not tracked.`;
	}
	return { path: candidate, state: "new" };
}

async function pathExists(filePath: string): Promise<boolean | string> {
	try {
		await lstat(filePath);
		return true;
	} catch (error) {
		const errno = error as NodeJS.ErrnoException;
		if (errno.code === "ENOENT") return false;
		return `Cannot inspect '${filePath}': ${errorMessage(error)}`;
	}
}

function formatPaths(label: string, paths: readonly string[]): string {
	return `${label}: ${paths.length > 0 ? paths.join(", ") : "none"}`;
}

function result(
	text: string,
	details: ToolDetails = { added: [], deleted: [], unchanged: [] },
): AgentToolResult<ToolDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
