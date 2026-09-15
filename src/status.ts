/**
 * Read-only git inspection for coding-agent workflows.
 *
 * Invariants:
 * - Executes only non-destructive local git commands.
 * - Rejects rev/base/head values that start with '-'.
 * - Truncates patch-heavy output uniformly, spilling the full result to a recoverable file.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatGitFailure, runGit } from "./utils/git";
import {
	buildExpandableOutput,
	type ExpandableOutputDetails,
	formatThemedExpandableOutput,
} from "./utils/tool-output";

const DESCRIPTION = [
	"Read-only git inspection for coding-agent workflows. Replaces direct git status/diff/log/show.",
	"Use for pre-task reconnaissance and planning: start with overview, then drill down with diff, log, or show. Do not use view=status.",
	"Views: overview reports branch/upstream, pending files, tags, and recent commits. The diff view shows unstaged, staged, or base..head patches/stat. The log view lists commits with optional filters/patches. The show view renders one revision.",
	"Only non-destructive local git commands run. Patch-heavy output is truncated with the complete result recoverable via the reported spill file. Use pattern for exhaustive diff searches.",
	'Examples: {}; {"view":"diff","staged":true}; {"view":"diff","base":"HEAD~3","head":"HEAD","stat":true}; {"view":"log","grep":"fix","patch":true}; {"view":"show","rev":"HEAD~1","path":"src/file.ts"}.',
];

const ALLOWED_VIEWS = new Set(["overview", "diff", "log", "show"]);

type BranchInfo = {
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	detached: boolean;
	gone: boolean;
	initial: boolean;
};

type ChangedFile = {
	code: string;
	path: string;
	renamedFrom?: string;
};

const parameters = Type.Object({
	view: Type.Optional(
		Type.String({
			description:
				"Inspection view: overview, diff, log, show. Omit for default overview. Do not use 'status' as a view value.",
		}),
	),
	rev: Type.Optional(
		Type.String({
			description:
				"Revision for view=show (default: HEAD), or starting point for view=log.",
		}),
	),
	base: Type.Optional(
		Type.String({
			description: "Base revision for view=diff or view=log range mode.",
		}),
	),
	head: Type.Optional(
		Type.String({
			description: "Head revision for view=diff or view=log range mode.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description: "Optional path filter for overview/diff/log/show.",
		}),
	),
	grep: Type.Optional(
		Type.String({
			description: "Filter view=log commits by message pattern (--grep).",
		}),
	),
	pattern: Type.Optional(
		Type.String({
			description:
				"Search view=diff/show complete patch output and return matching lines with counts.",
		}),
	),
	author: Type.Optional(
		Type.String({
			description: "Filter view=log commits by author pattern (--author).",
		}),
	),
	max_commits: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 200,
			description:
				"Maximum number of commits to return for view=overview or view=log (default: 20).",
		}),
	),
	stat: Type.Optional(
		Type.Boolean({
			description:
				"Show only git --stat summaries (no full patch) in diff/show views.",
		}),
	),
	patch: Type.Optional(
		Type.Boolean({
			description: "Include per-commit patches in view=log output.",
		}),
	),
	staged: Type.Optional(
		Type.Boolean({
			description:
				"For view=diff default mode, show staged changes with git diff --cached instead of unstaged changes. Ignored in base..head range mode.",
		}),
	),
	include_untracked: Type.Optional(
		Type.Boolean({
			description:
				"For view=diff default unstaged mode, append diffs for untracked files (respecting .gitignore). Ignored in base..head range and staged modes.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof parameters, ToolDetails>({
		name: "status",
		label: "Status",
		description: DESCRIPTION.join(" "),
		parameters,
		renderCall(args, theme) {
			const view = args.view?.trim().toLowerCase() || "overview";
			const parts = [theme.fg("toolTitle", theme.bold("status"))];
			parts.push(theme.fg("accent", ` --view ${view}`));
			if (args.rev?.trim())
				parts.push(theme.fg("muted", ` --rev ${args.rev.trim()}`));
			if (args.base?.trim())
				parts.push(theme.fg("muted", ` --base ${args.base.trim()}`));
			if (args.head?.trim())
				parts.push(theme.fg("muted", ` --head ${args.head.trim()}`));
			if (args.path?.trim())
				parts.push(theme.fg("muted", ` --path ${args.path.trim()}`));
			if (args.grep?.trim())
				parts.push(theme.fg("muted", ` --grep ${args.grep.trim()}`));
			if (args.pattern?.trim())
				parts.push(theme.fg("muted", ` --pattern ${args.pattern.trim()}`));
			if (args.author?.trim())
				parts.push(theme.fg("muted", ` --author ${args.author.trim()}`));
			if (typeof args.max_commits === "number") {
				parts.push(theme.fg("dim", ` --max_commits ${args.max_commits}`));
			}
			if (typeof args.stat === "boolean") {
				parts.push(theme.fg("dim", ` --stat ${args.stat}`));
			}
			if (typeof args.patch === "boolean") {
				parts.push(theme.fg("dim", ` --patch ${args.patch}`));
			}
			if (typeof args.staged === "boolean") {
				parts.push(theme.fg("dim", ` --staged ${args.staged}`));
			}
			if (typeof args.include_untracked === "boolean") {
				parts.push(
					theme.fg("dim", ` --include_untracked ${args.include_untracked}`),
				);
			}
			return new Text(parts.join(""), 0, 0);
		},
		renderResult(result, options, theme) {
			return new Text(
				formatThemedExpandableOutput(
					result.details,
					options.expanded,
					theme,
					32,
				),
				0,
				0,
			);
		},
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			return await execute(params, ctx, signal);
		},
	});
}

const execute = async (
	params: Static<typeof parameters>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<ToolDetails>> => {
	const worktree = ctx.cwd;
	const view = params.view?.trim().toLowerCase() || "overview";
	const maxCommits = clampInt(params.max_commits, 20, 1, 200);

	if (!ALLOWED_VIEWS.has(view)) {
		return textResult(
			`Unsupported view '${view}'. Supported views: overview, diff, log, show. Use view=overview for git-status-like output.`,
		);
	}

	const validationError = validateRefInputs({
		rev: params.rev,
		base: params.base,
		head: params.head,
	});
	if (validationError) return textResult(validationError);

	const repoCheck = await runGit(
		["rev-parse", "--is-inside-work-tree"],
		worktree,
		signal,
	);
	if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== "true") {
		return textResult(
			`Not a git repository in the current worktree (${worktree}). ${formatGitFailure("rev-parse --is-inside-work-tree", repoCheck)}`,
		);
	}

	let text: string;
	if (view === "overview") {
		text = await renderOverview({
			worktree,
			path: params.path?.trim(),
			maxCommits,
			signal,
		});
	} else if (view === "diff") {
		text = await renderDiff({
			worktree,
			base: params.base?.trim(),
			head: params.head?.trim(),
			path: params.path?.trim(),
			stat: params.stat === true,
			staged: params.staged === true,
			includeUntracked: params.include_untracked === true,
			pattern: params.pattern?.trim(),
			signal,
		});
	} else if (view === "log") {
		text = await renderLog({
			worktree,
			rev: params.rev?.trim(),
			base: params.base?.trim(),
			head: params.head?.trim(),
			path: params.path?.trim(),
			grep: params.grep?.trim(),
			author: params.author?.trim(),
			patch: params.patch === true,
			maxCommits,
			signal,
		});
	} else {
		text = await renderShow({
			worktree,
			rev: params.rev?.trim() || "HEAD",
			path: params.path?.trim(),
			stat: params.stat === true,
			pattern: params.pattern?.trim(),
			signal,
		});
	}

	return textResult(text);
};

type ToolDetails = ExpandableOutputDetails;

function textResult(text: string): AgentToolResult<ToolDetails> {
	const { contentText, details } = buildExpandableOutput(text);
	return {
		content: [{ type: "text", text: contentText }],
		details,
	};
}

async function renderOverview(input: {
	worktree: string;
	path?: string;
	maxCommits: number;
	signal?: AbortSignal;
}): Promise<string> {
	const statusArgs = [
		"status",
		"--porcelain=v1",
		"-z",
		"--branch",
		"--untracked-files=all",
	];
	if (input.path) statusArgs.push("--", input.path);

	const [statusRes, logRes, headTagsRes, recentTagsRes] = await Promise.all([
		runGit(statusArgs, input.worktree, input.signal),
		runGit(
			[
				"log",
				`-n${input.maxCommits}`,
				"--pretty=format:%h%x09%ar%x09%d%x09%s",
				"--decorate=short",
				...(input.path ? ["--", input.path] : []),
			],
			input.worktree,
			input.signal,
		),
		runGit(
			["tag", "--points-at", "HEAD", "--sort=-creatordate"],
			input.worktree,
			input.signal,
		),
		runGit(
			[
				"for-each-ref",
				`--count=${input.maxCommits}`,
				"--sort=-creatordate",
				"--format=%(refname:short)%09%(creatordate:relative)",
				"refs/tags",
			],
			input.worktree,
			input.signal,
		),
	]);

	if (statusRes.exitCode !== 0) {
		return formatGitFailure(
			"status --porcelain=v1 -z --branch --untracked-files=all",
			statusRes,
		);
	}
	if (logRes.exitCode !== 0) {
		return formatGitFailure("log", logRes);
	}
	// Tag lookups are best-effort: a missing/empty tag list is not an error.
	const headTags =
		headTagsRes.exitCode === 0
			? headTagsRes.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
			: [];
	const recentTags =
		recentTagsRes.exitCode === 0
			? recentTagsRes.stdout
					.split(/\r?\n/)
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
			: [];

	const parsed = parsePorcelainV1ZStatus(statusRes.stdout);
	const lines: string[] = [];

	if (parsed.branch) {
		for (const branchLine of renderBranchSection(parsed.branch)) {
			lines.push(branchLine);
		}
	}

	lines.push("Pending changes:");
	lines.push(`  staged: ${parsed.staged}`);
	lines.push(`  unstaged: ${parsed.unstaged}`);
	lines.push(`  untracked: ${parsed.untracked}`);
	lines.push(`  conflicts: ${parsed.conflicts}`);

	lines.push("Changed files:");
	if (parsed.files.length > 0) {
		for (const file of parsed.files) {
			const pathPart = file.renamedFrom
				? `${file.renamedFrom} -> ${file.path}`
				: file.path;
			lines.push(`  [${file.code}] ${pathPart}`);
		}
	} else {
		lines.push("  none");
	}

	lines.push("Tags at HEAD:");
	if (headTags.length > 0) {
		for (const tag of headTags) lines.push(`  ${tag}`);
	} else {
		lines.push("  none");
	}

	lines.push("Recent tags:");
	if (recentTags.length > 0) {
		for (const entry of recentTags) {
			const [name, when] = entry.split("\t");
			lines.push(when ? `  ${name} (${when})` : `  ${name}`);
		}
	} else {
		lines.push("  none");
	}

	lines.push("Recent local commits:");
	const commits = logRes.stdout.trim();
	if (commits.length === 0) {
		lines.push("  none");
	} else {
		for (const line of commits.split(/\r?\n/)) lines.push(`  ${line}`);
	}

	return lines.join("\n");
}

async function renderDiff(input: {
	worktree: string;
	base?: string;
	head?: string;
	path?: string;
	stat: boolean;
	staged: boolean;
	includeUntracked: boolean;
	pattern?: string;
	signal?: AbortSignal;
}): Promise<string> {
	const pathArgs = input.path ? ["--", input.path] : [];
	const modeArgs = input.stat ? ["--stat"] : ["--patch"];

	if (input.base || input.head) {
		const range = `${input.base || "HEAD"}..${input.head || "HEAD"}`;
		const rangeRes = await runGit(
			["diff", ...modeArgs, range, ...pathArgs],
			input.worktree,
			input.signal,
		);
		if (rangeRes.exitCode !== 0) {
			return formatGitFailure(
				`diff ${input.stat ? "--stat" : "--patch"} ${range}`,
				rangeRes,
			);
		}
		return formatPatchOutput({
			patch: rangeRes.stdout,
			pattern: input.pattern,
		});
	}

	if (input.staged) {
		const stagedRes = await runGit(
			["diff", "--cached", ...modeArgs, ...pathArgs],
			input.worktree,
			input.signal,
		);
		if (stagedRes.exitCode !== 0) {
			return formatGitFailure(
				`diff --cached ${input.stat ? "--stat" : "--patch"}`,
				stagedRes,
			);
		}
		return formatPatchOutput({
			patch: stagedRes.stdout.trim() || "(no staged changes)",
			pattern: input.pattern,
		});
	}

	const unstagedRes = await runGit(
		["diff", ...modeArgs, ...pathArgs],
		input.worktree,
		input.signal,
	);
	if (unstagedRes.exitCode !== 0) {
		return formatGitFailure(
			`diff ${input.stat ? "--stat" : "--patch"}`,
			unstagedRes,
		);
	}

	if (!input.includeUntracked) {
		return formatPatchOutput({
			patch: unstagedRes.stdout.trim() || "(no unstaged changes)",
			pattern: input.pattern,
		});
	}

	const untracked = await renderUntrackedDiff({
		worktree: input.worktree,
		path: input.path,
		stat: input.stat,
		signal: input.signal,
	});
	const sectionParts = [
		input.stat ? "Unstaged stat:" : "Unstaged diff:",
		unstagedRes.stdout.trim() || "(no unstaged changes)",
		"",
		input.stat ? "Untracked stat:" : "Untracked diff:",
		untracked || "(no untracked files)",
	];

	return formatPatchOutput({
		patch: sectionParts.join("\n"),
		pattern: input.pattern,
	});
}

async function renderUntrackedDiff(input: {
	worktree: string;
	path?: string;
	stat: boolean;
	signal?: AbortSignal;
}): Promise<string> {
	const lsArgs = ["ls-files", "--others", "--exclude-standard", "-z"];
	if (input.path) lsArgs.push("--", input.path);
	const lsRes = await runGit(lsArgs, input.worktree, input.signal);
	if (lsRes.exitCode !== 0) {
		return formatGitFailure("ls-files --others --exclude-standard", lsRes);
	}

	const files = lsRes.stdout.split("\0").filter((file) => file.length > 0);
	if (files.length === 0) return "";

	const modeArgs = input.stat ? ["--stat"] : ["--patch"];
	const diffs = await Promise.all(
		files.map((file) =>
			runGit(
				["diff", "--no-index", ...modeArgs, "--", "/dev/null", file],
				input.worktree,
				input.signal,
			),
		),
	);

	const parts: string[] = [];
	for (let i = 0; i < files.length; i += 1) {
		const res = diffs[i];
		if (!res) continue;
		// `git diff --no-index` exits 1 when differences exist (always true for a
		// new file vs /dev/null), so only codes >1 indicate a real failure.
		if (res.exitCode > 1) {
			parts.push(
				formatGitFailure(`diff --no-index -- /dev/null ${files[i]}`, res),
			);
			continue;
		}
		const out = res.stdout.trim();
		if (out.length > 0) parts.push(out);
	}

	return parts.join("\n");
}

async function renderLog(input: {
	worktree: string;
	rev?: string;
	base?: string;
	head?: string;
	path?: string;
	grep?: string;
	author?: string;
	patch: boolean;
	maxCommits: number;
	signal?: AbortSignal;
}): Promise<string> {
	const args: string[] = [
		"log",
		`-n${input.maxCommits}`,
		"--pretty=format:%h%x09%ar%x09%d%x09%s",
		"--decorate=short",
	];

	if (input.patch) args.push("--patch");
	if (input.grep) args.push(`--grep=${input.grep}`);
	if (input.author) args.push(`--author=${input.author}`);

	if (input.base || input.head) {
		args.push(`${input.base || "HEAD"}..${input.head || "HEAD"}`);
	} else if (input.rev) {
		args.push(input.rev);
	}

	if (input.path) args.push("--", input.path);

	const res = await runGit(args, input.worktree, input.signal);
	if (res.exitCode !== 0) return formatGitFailure("log", res);

	const trimmed = res.stdout.trim();
	if (!trimmed) return "No commits found.";
	return trimmed;
}

async function renderShow(input: {
	worktree: string;
	rev: string;
	path?: string;
	stat: boolean;
	pattern?: string;
	signal?: AbortSignal;
}): Promise<string> {
	const args = input.stat
		? [
				"log",
				"-n1",
				"--stat",
				"--decorate=short",
				"--format=fuller",
				input.rev,
				...(input.path ? ["--", input.path] : []),
			]
		: [
				"show",
				"--patch",
				"--decorate=short",
				"--format=fuller",
				input.rev,
				...(input.path ? ["--", input.path] : []),
			];
	const res = await runGit(args, input.worktree, input.signal);
	if (res.exitCode !== 0) {
		return formatGitFailure(
			`${input.stat ? "log -n1 --stat" : "show --patch"} --format=fuller ${input.rev}`,
			res,
		);
	}
	return formatPatchOutput({
		patch: res.stdout,
		pattern: input.pattern,
	});
}

function parsePorcelainV1ZStatus(content: string): {
	branch?: BranchInfo;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicts: number;
	files: ChangedFile[];
} {
	let branch: BranchInfo | undefined;
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let conflicts = 0;
	const files: ChangedFile[] = [];

	const entries = content.split("\0").filter((entry) => entry.length > 0);
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i] ?? "";
		if (entry.startsWith("## ")) {
			branch = parseBranchHeader(entry.slice(3));
			continue;
		}

		if (entry.length < 4) continue;
		const x = entry[0] || " ";
		const y = entry[1] || " ";
		const code = `${x}${y}`;
		const pathPart = entry.slice(3);

		if (code === "??") {
			untracked += 1;
			files.push({ code, path: pathPart });
			continue;
		}

		if (isConflictPair(x, y)) conflicts += 1;
		if (x !== " ") staged += 1;
		if (y !== " ") unstaged += 1;

		if ((x === "R" || x === "C") && i + 1 < entries.length) {
			const renamedFrom = pathPart;
			const nextPath = entries[i + 1] ?? "";
			files.push({ code, renamedFrom, path: nextPath });
			i += 1;
			continue;
		}

		files.push({ code, path: pathPart });
	}

	return { branch, staged, unstaged, untracked, conflicts, files };
}

function parseBranchHeader(rest: string): BranchInfo {
	const info: BranchInfo = {
		ahead: 0,
		behind: 0,
		detached: false,
		gone: false,
		initial: false,
	};

	let body = rest.trim();

	if (body === "HEAD" || body.startsWith("HEAD (")) {
		info.detached = true;
		return info;
	}

	const initialPrefix = "No commits yet on ";
	if (body.startsWith(initialPrefix)) {
		info.initial = true;
		body = body.slice(initialPrefix.length);
	}

	const bracketMatch = body.match(/\s\[([^\]]+)\]\s*$/);
	if (bracketMatch && typeof bracketMatch.index === "number") {
		const tokens = (bracketMatch[1] ?? "")
			.split(",")
			.map((token) => token.trim());
		for (const token of tokens) {
			if (token === "gone") {
				info.gone = true;
				continue;
			}
			const aheadMatch = token.match(/^ahead (\d+)$/);
			if (aheadMatch) {
				info.ahead = Number.parseInt(aheadMatch[1] ?? "0", 10);
				continue;
			}
			const behindMatch = token.match(/^behind (\d+)$/);
			if (behindMatch) {
				info.behind = Number.parseInt(behindMatch[1] ?? "0", 10);
			}
		}
		body = body.slice(0, bracketMatch.index).trim();
	}

	const sep = body.indexOf("...");
	if (sep >= 0) {
		info.branch = body.slice(0, sep);
		info.upstream = body.slice(sep + 3);
	} else if (body.length > 0) {
		info.branch = body;
	}

	return info;
}

function renderBranchSection(info: BranchInfo): string[] {
	const lines: string[] = [];

	if (info.detached) {
		lines.push("Branch: (detached HEAD)");
		return lines;
	}

	const branchLabel = info.branch ?? "(unknown)";
	const initialSuffix = info.initial ? " (no commits yet)" : "";
	lines.push(`Branch: ${branchLabel}${initialSuffix}`);

	if (info.upstream) {
		const parts: string[] = [];
		if (info.gone) {
			parts.push("gone");
		} else {
			if (info.ahead > 0) parts.push(`ahead ${info.ahead}`);
			if (info.behind > 0) parts.push(`behind ${info.behind}`);
		}
		const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
		lines.push(`Upstream: ${info.upstream}${suffix}`);
	} else {
		lines.push("Upstream: (none)");
	}

	return lines;
}

const CONFLICT_PAIRS = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function isConflictPair(x: string, y: string): boolean {
	return CONFLICT_PAIRS.has(`${x}${y}`);
}

// Full-patch truncation is delegated to the shared expandable-output policy in
// textResult (line/byte caps plus spill-file recovery); this only normalizes
// empty patches and applies the optional pattern search.
type PatchOutputInput = {
	patch: string;
	pattern?: string;
};

function formatPatchOutput(input: PatchOutputInput): string {
	const normalized = input.patch.length > 0 ? input.patch : "(no output)";
	if (input.pattern) return searchPatch(normalized, input.pattern);
	return normalized;
}

function searchPatch(content: string, pattern: string): string {
	const lines = content.split(/\r?\n/);
	const matches: string[] = [];
	const matchedFiles = new Set<string>();
	let currentFile = "(unknown)";

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const file = parseDiffGitLine(line);
		if (file) currentFile = file;
		if (!line.includes(pattern)) continue;
		matches.push(`${currentFile}:${i + 1}: ${line}`);
		matchedFiles.add(currentFile);
	}

	const header = `PATTERN ${JSON.stringify(pattern)}: ${matches.length} match(es) across ${matchedFiles.size} file(s)`;
	return matches.length > 0 ? [header, ...matches].join("\n") : header;
}

function parseDiffGitLine(line: string): string | null {
	if (!line.startsWith("diff --git ")) return null;
	const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
	return match?.[2] ?? null;
}

function clampInt(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (typeof value !== "number" || Number.isNaN(value)) return fallback;
	if (!Number.isFinite(value)) return fallback;
	const floored = Math.floor(value);
	if (floored < min) return min;
	if (floored > max) return max;
	return floored;
}

function validateRefInputs(input: {
	rev?: string;
	base?: string;
	head?: string;
}): string | null {
	if (startsWithDash(input.rev)) {
		return "Invalid --rev: revision cannot start with '-'.";
	}
	if (startsWithDash(input.base)) {
		return "Invalid --base: revision cannot start with '-'.";
	}
	if (startsWithDash(input.head)) {
		return "Invalid --head: revision cannot start with '-'.";
	}
	return null;
}

function startsWithDash(value: string | undefined): boolean {
	if (!value) return false;
	return value.trim().startsWith("-");
}
