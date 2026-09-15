/**
 * Manages deterministic I/O for the issues-analysis workflow.
 *
 * Invariants:
 * - The model owns judgment; this tool owns validation, layout, and cleanup.
 * - `context` analyzes the working tree, including untracked files.
 * - `write` replaces the complete issues set and details directory.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { runGit } from "./utils/git";
import {
	buildExpandableOutput,
	type ExpandableOutputDetails,
	formatThemedExpandableOutput,
} from "./utils/tool-output";

type ToolDetails = ExpandableOutputDetails;

const ACTIONS = ["context", "write"] as const;
type Action = (typeof ACTIONS)[number];

// Forward slashes: these double as git pathspecs (which reject backslashes) and
// as fs paths (Node accepts "/" on every platform).
const INDEX_REL = "issues/index.md";
const DETAILS_REL = "issues/details";

// Index section heading -> issue kind, in canonical order.
const SECTION_KINDS: Array<{ heading: string; kind: string }> = [
	{ heading: "Bugs", kind: "bug" },
	{ heading: "Security", kind: "security" },
	{ heading: "Inconsistencies", kind: "inconsistency" },
	{ heading: "Documentation drift", kind: "doc-drift" },
	{ heading: "TODOs", kind: "todo" },
	{ heading: "Coherence", kind: "coherence" },
];

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const HEADLINE_MAX = 120;

const DESCRIPTION = [
	"Manage the issues catalog workflow.",
	"context returns the prior index commit, changed files (with working-tree changes), and current index. write replaces the full catalog.",
];

const issueEntrySchema = Type.Object({
	id: Type.String({
		description:
			"Stable lowercase hyphen id, for example auth-session-token-eq.",
	}),
	kind: Type.String({
		description: "bug, security, inconsistency, doc-drift, todo, or coherence.",
	}),
	path: Type.String({
		description: "Repo-relative issue path. No '..' segments.",
	}),
	line: Type.Integer({
		minimum: 1,
		description: "1-based issue line.",
	}),
	headline: Type.String({
		description: "Declarative claim with a verb. No path. ~100 chars.",
	}),
	rationale: Type.String({
		description: "Two to four sentence rationale for the index.",
	}),
	context: Type.String({
		description: "Detail Context section: 2-4 sentences plus cross-references.",
	}),
	evidence: Type.String({
		description:
			"Detail Evidence section: code excerpts or file:line references.",
	}),
	notes: Type.Optional(
		Type.String({
			description: "Optional detail Notes section for caveats or uncertainty.",
		}),
	),
});

type IssueEntry = Static<typeof issueEntrySchema>;

const parameters = Type.Object({
	action: Type.String({
		description: "context or write.",
	}),
	entries: Type.Optional(
		Type.Array(issueEntrySchema, {
			description:
				"For write: complete issue set. [] writes a clean index and deletes omissions.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof parameters, ToolDetails>({
		name: "issues",
		label: "Issues",
		description: DESCRIPTION.join(" "),
		parameters,
		// write nukes and rewrites issues/details/; concurrent calls touching
		// the shared issues state would corrupt it.
		executionMode: "sequential",
		renderCall(args, theme) {
			const action = args.action?.trim().toLowerCase() || "(none)";
			const parts = [
				theme.fg("toolTitle", theme.bold("issues ")),
				theme.fg("accent", action),
			];
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
	const action = params.action?.trim().toLowerCase() as Action | undefined;
	const worktree = ctx.cwd;
	switch (action) {
		case "context":
			return textResult(await renderContext(worktree, signal));
		case "write":
			return textResult(await renderWrite(worktree, params.entries));
		default:
			return textResult(
				`Unknown action '${params.action ?? ""}'. Supported actions: ${ACTIONS.join(", ")}.`,
			);
	}
};

async function renderContext(
	worktree: string,
	signal?: AbortSignal,
): Promise<string> {
	const repoCheck = await runGit(
		["rev-parse", "--is-inside-work-tree"],
		worktree,
		signal,
	);
	if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== "true") {
		return `Not a git repository in the current worktree (${worktree}).`;
	}

	const prevRes = await runGit(
		["log", "-1", "--format=%H", "--", INDEX_REL],
		worktree,
		signal,
	);
	const prev = prevRes.exitCode === 0 ? prevRes.stdout.trim() : "";
	const fresh = prev.length === 0;

	let changed = "";
	if (!fresh) {
		// `git diff <commit>` (no second ref) compares the commit against the
		// working tree, so this covers committed, staged, and unstaged tracked
		// changes since the previously analyzed commit.
		const changedRes = await runGit(
			["diff", "--name-status", prev, "--", ".", `:(exclude)issues/`],
			worktree,
			signal,
		);
		const diffChanged =
			changedRes.exitCode === 0 ? changedRes.stdout.trim() : "";
		// git diff omits untracked files; list them so a pre-commit scan sees new
		// files too. Prefix with the porcelain '??' code to match the diff column.
		const untrackedRes = await runGit(
			[
				"ls-files",
				"--others",
				"--exclude-standard",
				"--",
				".",
				`:(exclude)issues/`,
			],
			worktree,
			signal,
		);
		const untracked =
			untrackedRes.exitCode === 0 ? untrackedRes.stdout.trim() : "";
		const untrackedLines = untracked
			? untracked
					.split(/\r?\n/)
					.map((file) => `??\t${file}`)
					.join("\n")
			: "";
		changed = [diffChanged, untrackedLines].filter(Boolean).join("\n");
	}

	const indexText = await readFileMaybe(path.join(worktree, INDEX_REL));

	const lines: string[] = [];
	lines.push(
		fresh
			? "Previously analyzed commit: none (fresh analysis of whole repo)"
			: `Previously analyzed commit: ${prev}`,
	);
	lines.push("");

	if (fresh) {
		lines.push("Fresh analysis: no prior issues — survey the whole tree.");
		lines.push("");
	} else {
		lines.push(
			"Changed files since previously analyzed commit, including the working tree (excludes issues/):",
		);
		lines.push(changed ? indent(changed) : "  none");
		lines.push("");
	}

	lines.push("=== Current issues/index.md ===");
	lines.push(indexText ?? "(none — no prior issues)");
	lines.push(
		"",
		"Read any issues/details/<id>.md you need directly; this action does not inline them.",
	);

	return lines.join("\n");
}

async function renderWrite(
	worktree: string,
	entries: IssueEntry[] | undefined,
): Promise<string> {
	if (!entries) {
		return "action=write requires an 'entries' array (use [] to write a clean index).";
	}

	const violations = validateEntries(entries);
	if (violations.length > 0) {
		return [
			`Cannot write: ${violations.length} violation(s) (no files written):`,
			"",
			...violations.map((v) => `- ${v}`),
		].join("\n");
	}

	const detailsDir = path.join(worktree, DETAILS_REL);
	// These writes bypass the tools.ts path-guard (getPathInputs has no issues
	// branch). Staying inside worktree/issues/ is guaranteed here by fixed
	// targets plus validateEntries, which rejects ids and paths that could escape
	// (ID_PATTERN forbids slashes/dots; path validation forbids absolute and
	// '..'). Preserve that invariant if these targets ever become dynamic.
	//
	// Nuke-and-pave: the passed set is the entire issues state, so wipe the
	// details directory before writing rather than diffing for orphans.
	await rm(detailsDir, { recursive: true, force: true });
	await mkdir(detailsDir, { recursive: true });

	for (const entry of entries) {
		const target = path.join(detailsDir, `${entry.id}.md`);
		await writeFile(target, buildDetail(entry), "utf8");
	}

	await writeFile(path.join(worktree, INDEX_REL), buildIndex(entries), "utf8");

	const lines = [`Wrote ${INDEX_REL} and ${entries.length} detail file(s).`];
	for (const { heading, kind } of SECTION_KINDS) {
		const count = entries.filter((entry) => entry.kind === kind).length;
		if (count > 0) lines.push(`  ${heading}: ${count}`);
	}
	return lines.join("\n");
}

function validateEntries(entries: IssueEntry[]): string[] {
	const violations: string[] = [];
	const validKinds = new Set(SECTION_KINDS.map((s) => s.kind));
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!ID_PATTERN.test(entry.id)) {
			violations.push(
				`invalid id '${entry.id}': expected lowercase <area>-<concern> with hyphens.`,
			);
		}
		if (seen.has(entry.id)) {
			violations.push(`duplicate id '${entry.id}'.`);
		} else {
			seen.add(entry.id);
		}
		if (!validKinds.has(entry.kind)) {
			violations.push(
				`invalid kind '${entry.kind}' for '${entry.id}': expected one of ${Array.from(validKinds).join(", ")}.`,
			);
		}
		if (
			entry.path.trim().length === 0 ||
			path.isAbsolute(entry.path) ||
			entry.path.split(/[\\/]/).includes("..")
		) {
			violations.push(
				`invalid path '${entry.path}' for '${entry.id}': expected a repo-relative path with no '..' segments.`,
			);
		}
		if (entry.headline.length > HEADLINE_MAX) {
			violations.push(
				`headline too long for '${entry.id}': ${entry.headline.length} chars, limit ~${HEADLINE_MAX}.`,
			);
		}
	}
	return violations;
}

function compareEntries(a: IssueEntry, b: IssueEntry): number {
	return (
		a.path.localeCompare(b.path) || a.line - b.line || a.id.localeCompare(b.id)
	);
}

function buildIndex(entries: IssueEntry[]): string {
	const lines: string[] = ["---", "counts:"];
	for (const { kind } of SECTION_KINDS) {
		const count = entries.filter((entry) => entry.kind === kind).length;
		lines.push(`  ${kind}: ${count}`);
	}
	lines.push("---", "", "# Issues");

	for (const { heading, kind } of SECTION_KINDS) {
		const list = entries
			.filter((entry) => entry.kind === kind)
			.sort(compareEntries);
		if (list.length === 0) continue;
		lines.push("", `## ${heading} (${list.length})`);
		for (const entry of list) {
			lines.push(
				"",
				`### ${entry.headline}`,
				"",
				`details/${entry.id}.md`,
				"",
				entry.rationale.trim(),
			);
		}
	}

	return `${lines.join("\n")}\n`;
}

function buildDetail(entry: IssueEntry): string {
	const lines = [
		"---",
		`id: ${entry.id}`,
		`kind: ${entry.kind}`,
		`location: ${entry.path}:${entry.line}`,
		"---",
		"",
		`# ${entry.headline}`,
		"",
		"## Rationale",
		entry.rationale.trim(),
		"",
		"## Context",
		entry.context.trim(),
		"",
		"## Evidence",
		entry.evidence.trim(),
	];
	const notes = entry.notes?.trim();
	if (notes) lines.push("", "## Notes", notes);
	return `${lines.join("\n")}\n`;
}

async function readFileMaybe(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch {
		return undefined;
	}
}

function indent(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => `  ${line}`)
		.join("\n");
}

function textResult(text: string): AgentToolResult<ToolDetails> {
	const { contentText, details } = buildExpandableOutput(text);
	return {
		content: [{ type: "text", text: contentText }],
		details,
	};
}
