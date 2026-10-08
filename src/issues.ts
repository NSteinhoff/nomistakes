/** Preserves untouched issues across incremental analysis. */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { lstatOrNull } from "./utils/fs";
import { formatGitFailure, runGit } from "./utils/git";
import { deriveSessionName, openChildSession } from "./utils/session";
import {
	type ExpandableOutputDetails,
	renderExpandableToolResult,
	buildExpandableToolResult as textResult,
} from "./utils/tool-output";

type ToolDetails = ExpandableOutputDetails;

const ACTIONS = ["context", "apply"] as const;
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
	"Call this tool directly for catalog maintenance without build or verification workflows.",
	"context returns the prior index commit, changed files (with working-tree changes), and current index. apply adds, updates, or removes explicit issues and refreshes the analysis timestamp. Omitted issues and fields remain unchanged.",
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

const PROSE_SECTIONS = [
	{ field: "rationale", heading: "Rationale" },
	{ field: "context", heading: "Context" },
	{ field: "evidence", heading: "Evidence" },
	{ field: "notes", heading: "Notes" },
] as const;
type ProseField = (typeof PROSE_SECTIONS)[number]["field"];
type MarkdownBoundary = { field: ProseField; start: number; end: number };
type Catalog = {
	entries: Map<string, IssueEntry>;
	ambiguous: Set<string>;
};

const issueChangesSchema = Type.Partial(Type.Omit(issueEntrySchema, ["id"]), {
	additionalProperties: false,
});

const parameters = Type.Object(
	{
		action: Type.Union([Type.Literal(ACTIONS[0]), Type.Literal(ACTIONS[1])]),
		add: Type.Optional(
			Type.Array(issueEntrySchema, {
				description:
					"Complete new issues. Each ID must be absent from the catalog.",
			}),
		),
		update: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: issueEntrySchema.properties.id,
						changes: issueChangesSchema,
					},
					{ additionalProperties: false },
				),
				{
					description:
						"Updates to existing IDs. Omitted fields remain unchanged. Use empty notes to remove notes.",
				},
			),
		),
		remove: Type.Optional(
			Type.Array(issueEntrySchema.properties.id, {
				description:
					"Existing issue IDs to remove. Omitted IDs remain unchanged.",
			}),
		),
	},
	{ additionalProperties: false },
);

type IssueSelection = {
	readonly choice: string;
	readonly newSession: boolean;
};

const ISSUE_SELECTOR_ROWS = 10;

async function selectIssue(
	ctx: ExtensionContext,
	choices: readonly string[],
): Promise<IssueSelection | null> {
	return ctx.ui.custom<IssueSelection | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", "Select an issue")));
		const list = new SelectList(
			choices.map((choice) => ({ value: choice, label: choice })),
			Math.min(choices.length, ISSUE_SELECTOR_ROWS),
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		);
		list.onSelect = (item) => done({ choice: item.value, newSession: false });
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					"↑↓ navigate • enter load • shift+enter new session • esc cancel",
				),
			),
		);
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (matchesKey(data, Key.shift("enter"))) {
					const item = list.getSelectedItem();
					if (item !== null) done({ choice: item.value, newSession: true });
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const item = list.getSelectedItem();
					if (item !== null) done({ choice: item.value, newSession: false });
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	let cwd: string | null = null;
	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
	});

	pi.registerCommand("issue", {
		description:
			"Select a catalog issue, optionally by kind, for the current or a child session",
		getArgumentCompletions: async (prefix) => {
			if (cwd === null) return null;
			let catalog: Catalog | string;
			try {
				catalog = await loadCatalog(cwd);
			} catch {
				return null;
			}
			if (typeof catalog === "string") return null;

			const availableKinds = new Set(
				[...catalog.entries.values()].map(({ kind }) => kind),
			);
			const query = prefix.trimStart().toLowerCase();
			const items = SECTION_KINDS.filter(
				({ kind }) => availableKinds.has(kind) && kind.startsWith(query),
			).map(({ kind }) => ({ value: kind, label: kind }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("issue requires interactive mode", "error");
				return;
			}

			const kind = args.trim();
			const kindOrder = SECTION_KINDS.map(({ kind }) => kind);
			if (kind && !kindOrder.includes(kind)) {
				ctx.ui.notify(
					`Unknown issue kind '${kind}'. Accepted kinds: ${kindOrder.join(", ")}.`,
					"error",
				);
				return;
			}

			const catalog = await loadCatalog(ctx.cwd);
			if (typeof catalog === "string") {
				ctx.ui.notify(catalog, "error");
				return;
			}
			const entries = [...catalog.entries.values()]
				.filter((entry) => !kind || entry.kind === kind)
				.sort(
					(a, b) =>
						kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) ||
						compareEntries(a, b),
				);
			if (entries.length === 0) {
				ctx.ui.notify(
					kind
						? `No open issues for kind '${kind}'`
						: "No open issues in the catalog",
					"info",
				);
				return;
			}
			const choices = new Map<string, IssueEntry>();
			for (const entry of entries) {
				choices.set(
					`[${entry.kind}] ${entry.headline} — ${entry.path}:${entry.line} (${entry.id})`,
					entry,
				);
			}
			const selected = await selectIssue(ctx, [...choices.keys()]);
			if (selected === null) return;
			const entry = choices.get(selected.choice);
			if (entry === undefined) return;

			const contextEntry = {
				customType: "issue-context",
				content: buildDetail(entry),
			};
			if (!selected.newSession) {
				pi.sendMessage(
					{ ...contextEntry, display: true, details: undefined },
					{ triggerTurn: false },
				);
				ctx.ui.notify(
					`Issue ${entry.id} loaded. Submit a message to start.`,
					"info",
				);
				return;
			}

			const result = await openChildSession(ctx, {
				name: deriveSessionName(entry.headline),
				contextEntry,
				readyNotice: `Issue ${entry.id} loaded. Submit a message to start.`,
			});
			if (result.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});

	pi.registerCommand("issues", {
		description: "List open catalog issues",
		handler: async (_args, ctx) => {
			const catalog = await loadCatalog(ctx.cwd);
			if (typeof catalog === "string") {
				ctx.ui.notify(catalog, "error");
				return;
			}
			const entries = [...catalog.entries.values()];
			const lines = SECTION_KINDS.flatMap(({ kind }) =>
				entries
					.filter((entry) => entry.kind === kind)
					.sort(compareEntries)
					.map(
						(entry) =>
							`[${entry.kind}] ${entry.headline} — ${entry.path}:${entry.line} (${entry.id})`,
					),
			);
			ctx.ui.notify(
				lines.length > 0 ? lines.join("\n") : "No open issues in the catalog",
				"info",
			);
		},
	});

	pi.registerTool<typeof parameters, ToolDetails>({
		name: "issues",
		label: "Issues",
		description: DESCRIPTION.join(" "),
		promptGuidelines: [
			"Use issues directly to record, update, or remove established findings. Curator delegation is optional and serves repository analysis.",
			"Catalog maintenance is administrative state, like todo updates, not source implementation. It requires no implementation authorization, baseline checks, builds, formatters, or post-change verification.",
			"If an issues operation fails validation, correct the request and retry. Do not edit catalog files manually.",
		],
		parameters,
		// Each delta depends on the catalog state from the previous call.
		executionMode: "sequential",
		renderCall(args, theme) {
			const action = args.action?.trim().toLowerCase() || "(none)";
			const parts = [
				theme.fg("toolTitle", theme.bold("issues ")),
				theme.fg("accent", action),
			];
			return new Text(parts.join(""), 0, 0);
		},
		renderResult: renderExpandableToolResult,
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
		case "apply":
			return textResult(await renderApply(worktree, params));
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
	const repoCheck = await runGit({
		args: ["rev-parse", "--is-inside-work-tree"],
		cwd: worktree,
		signal,
	});
	if (repoCheck.exitCode !== 0) {
		return formatGitFailure("rev-parse --is-inside-work-tree", repoCheck);
	}
	if (repoCheck.stdout.trim() !== "true") {
		return `Not a git repository in the current worktree (${worktree}).`;
	}

	const prevRes = await runGit({
		args: ["log", "-1", "--format=%H", "--", INDEX_REL],
		cwd: worktree,
		signal,
	});
	if (prevRes.exitCode !== 0) {
		return formatGitFailure(`log -1 --format=%H -- ${INDEX_REL}`, prevRes);
	}
	const prev = prevRes.stdout.trim();
	const fresh = prev.length === 0;

	let changed = "";
	if (!fresh) {
		// `git diff <commit>` (no second ref) compares the commit against the
		// working tree, so this covers committed, staged, and unstaged tracked
		// changes since the previously analyzed commit.
		const changedRes = await runGit({
			args: ["diff", "--name-status", prev, "--", ".", `:(exclude)issues/`],
			cwd: worktree,
			signal,
		});
		if (changedRes.exitCode !== 0) {
			return formatGitFailure(
				`diff --name-status ${prev} -- . :(exclude)issues/`,
				changedRes,
			);
		}
		const diffChanged = changedRes.stdout.trim();
		// git diff omits untracked files; list them so a pre-commit scan sees new
		// files too. Prefix with the porcelain '??' code to match the diff column.
		const untrackedRes = await runGit({
			args: [
				"ls-files",
				"--others",
				"--exclude-standard",
				"--",
				".",
				`:(exclude)issues/`,
			],
			cwd: worktree,
			signal,
		});
		if (untrackedRes.exitCode !== 0) {
			return formatGitFailure(
				"ls-files --others --exclude-standard -- . :(exclude)issues/",
				untrackedRes,
			);
		}
		const untracked = untrackedRes.stdout.trim();
		const untrackedLines = untracked
			? untracked
					.split(/\r?\n/)
					.map((file) => `??\t${file}`)
					.join("\n")
			: "";
		changed = [diffChanged, untrackedLines].filter(Boolean).join("\n");
	}

	const pathError = await validateCatalogPaths(worktree, ["issues", INDEX_REL]);
	if (pathError) return pathError;
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

async function renderApply(
	worktree: string,
	params: Static<typeof parameters>,
): Promise<string> {
	const catalog = await loadCatalog(worktree);
	if (typeof catalog === "string")
		return `Cannot apply (no files written): ${catalog}`;
	const current = catalog.entries;
	const { entries, violations } = buildDelta(catalog, params);
	if (violations.length > 0) {
		return [
			`Cannot apply: ${violations.length} violation(s) (no files written):`,
			"",
			...violations.map((v) => `- ${v}`),
		].join("\n");
	}
	const changed = entries.filter((entry) => {
		const previous = current.get(entry.id);
		return !previous || buildDetail(entry) !== buildDetail(previous);
	});
	await persistDelta(
		worktree,
		changed,
		params.remove ?? [],
		buildIndex(entries, new Date().toISOString()),
	);
	const updated = changed.filter((entry) => current.has(entry.id)).length;
	return renderApplySummary(
		entries,
		params.add?.length ?? 0,
		updated,
		params.remove?.length ?? 0,
	);
}

function buildDelta(
	catalog: Catalog,
	params: Static<typeof parameters>,
): { entries: IssueEntry[]; violations: string[] } {
	const current = catalog.entries;
	const add = params.add ?? [];
	const update = params.update ?? [];
	const remove = params.remove ?? [];
	const next = new Map(current);
	const violations: string[] = [];
	const seen = new Set<string>();
	for (const id of [
		...add.map((entry) => entry.id),
		...update.map((entry) => entry.id),
		...remove,
	]) {
		if (!ID_PATTERN.test(id)) violations.push(`invalid id '${id}'.`);
		if (seen.has(id))
			violations.push(`duplicate or conflicting operation for '${id}'.`);
		seen.add(id);
	}
	for (const entry of add) {
		if (current.has(entry.id))
			violations.push(`cannot add existing issue '${entry.id}'.`);
		violations.push(...validateProse(entry.id, entry));
		next.set(entry.id, entry);
	}
	for (const { id, changes } of update) {
		const entry = current.get(id);
		if (!entry) {
			violations.push(`cannot update unknown issue '${id}'.`);
			continue;
		}
		if (catalog.ambiguous.has(id)) {
			violations.push(
				`cannot update '${id}': existing Markdown field boundaries are ambiguous.`,
			);
			continue;
		}
		violations.push(...validateProse(id, changes));
		next.set(id, { ...entry, ...changes });
	}
	for (const id of remove) {
		if (!current.has(id))
			violations.push(`cannot remove unknown issue '${id}'.`);
		next.delete(id);
	}
	const entries = [...next.values()];
	violations.push(...validateEntries(entries));
	return { entries, violations };
}

function renderApplySummary(
	entries: IssueEntry[],
	added: number,
	updated: number,
	removed: number,
): string {
	const lines = [
		`Applied ${added} addition(s), ${updated} update(s), and ${removed} removal(s). Refreshed ${INDEX_REL}.`,
	];
	for (const { heading, kind } of SECTION_KINDS) {
		const count = entries.filter((entry) => entry.kind === kind).length;
		if (count > 0) lines.push(`  ${heading}: ${count}`);
	}
	return lines.join("\n");
}

async function persistDelta(
	worktree: string,
	changed: IssueEntry[],
	remove: string[],
	index: string,
): Promise<void> {
	const detailsDir = path.join(worktree, DETAILS_REL);
	const indexPath = path.join(worktree, INDEX_REL);
	const originalIndex = await readFileMaybe(indexPath);
	const originals = new Map<string, string | undefined>();
	for (const id of [...changed.map((entry) => entry.id), ...remove]) {
		const target = path.join(detailsDir, `${id}.md`);
		const stats = await lstatOrNull(target);
		if (stats && !stats.isFile())
			throw new Error(`Not a regular detail file: ${target}`);
		originals.set(target, await readFileMaybe(target));
	}
	await mkdir(detailsDir, { recursive: true });
	try {
		for (const entry of changed) {
			await writeFile(
				path.join(detailsDir, `${entry.id}.md`),
				buildDetail(entry),
				"utf8",
			);
		}
		for (const id of remove) await rm(path.join(detailsDir, `${id}.md`));
		await writeFile(indexPath, index, "utf8");
	} catch (error) {
		const errors: unknown[] = [error];
		try {
			if ((await readFileMaybe(indexPath)) !== originalIndex) {
				if (originalIndex === undefined) await rm(indexPath, { force: true });
				else await writeFile(indexPath, originalIndex, "utf8");
			}
		} catch (restoreError) {
			errors.push(restoreError);
		}
		for (const [target, original] of originals) {
			try {
				if (original === undefined) await rm(target, { force: true });
				else await writeFile(target, original, "utf8");
			} catch (restoreError) {
				errors.push(restoreError);
			}
		}
		throw new AggregateError(
			errors,
			"Catalog write failed. Detail restoration errors follow the original error, if any.",
		);
	}
}

async function validateCatalogPaths(
	worktree: string,
	relatives: readonly string[],
): Promise<string | undefined> {
	for (const relative of relatives) {
		const stats = await lstatOrNull(path.join(worktree, relative));
		if (!stats) continue;
		if (relative === INDEX_REL ? !stats.isFile() : !stats.isDirectory()) {
			return `invalid catalog path '${relative}': expected a regular ${relative === INDEX_REL ? "file" : "directory"}.`;
		}
	}
	return undefined;
}

async function loadCatalog(worktree: string): Promise<Catalog | string> {
	const pathError = await validateCatalogPaths(worktree, [
		"issues",
		DETAILS_REL,
		INDEX_REL,
	]);
	if (pathError) return pathError;
	const entries = new Map<string, IssueEntry>();
	const ambiguous = new Set<string>();
	const detailsDir = path.join(worktree, DETAILS_REL);
	let files: string[];
	try {
		files = await readdir(detailsDir);
	} catch (error) {
		if (!isMissingFile(error)) throw error;
		files = [];
	}
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const target = path.join(detailsDir, file);
		const stats = await lstatOrNull(target);
		if (!stats?.isFile())
			return `invalid detail path '${file}': expected a regular file.`;
		const text = await readFile(target, "utf8");
		const parsed = parseDetail(text);
		if (!parsed || file !== `${parsed.entry.id}.md`)
			return `invalid detail file '${file}'.`;
		const { entry } = parsed;
		if (entries.has(entry.id)) return `duplicate stored issue '${entry.id}'.`;
		entries.set(entry.id, entry);
		if (parsed.ambiguous) ambiguous.add(entry.id);
	}
	const violations = validateEntries([...entries.values()]);
	if (violations.length > 0) return violations.join("\n");
	const index = await readFileMaybe(path.join(worktree, INDEX_REL));
	if (
		index !== undefined &&
		!restoreAmbiguousRationales(index, entries, ambiguous)
	) {
		return "the index lacks a unique summary for an ambiguous detail file.";
	}
	const withoutTimestamp = (text: string): string =>
		text
			.replace(/\r\n/g, "\n")
			.replace(/^---\n[\s\S]*?\n---(?=\n|$)/, (frontMatter) =>
				frontMatter.replace(/^analyzed_at:.*\n/m, ""),
			);
	if (
		index === undefined
			? entries.size > 0
			: withoutTimestamp(index) !==
				withoutTimestamp(buildIndex([...entries.values()], ""))
	) {
		return "the index and detail files disagree. Repair the catalog before apply.";
	}
	return { entries, ambiguous };
}

function restoreAmbiguousRationales(
	index: string,
	entries: Map<string, IssueEntry>,
	ambiguous: Set<string>,
): boolean {
	index = index.replace(/\r\n/g, "\n");
	const { unfencedOffsets } = scanMarkdown(index);
	const markers = [...entries.values()].map(
		(entry) => `\n\n### ${entry.headline}\n\ndetails/${entry.id}.md\n\n`,
	);
	for (const { heading, kind } of SECTION_KINDS) {
		const count = [...entries.values()].filter(
			(entry) => entry.kind === kind,
		).length;
		if (count > 0) markers.push(`\n\n## ${heading} (${count})\n`);
	}
	for (const id of ambiguous) {
		const entry = entries.get(id);
		if (!entry) return false;
		const marker = `\n\n### ${entry.headline}\n\ndetails/${id}.md\n\n`;
		const start = findIndexMarker(index, marker, 0, unfencedOffsets);
		if (
			start < 0 ||
			findIndexMarker(index, marker, start + marker.length, unfencedOffsets) >=
				0
		)
			return false;
		const contentStart = start + marker.length;
		let end = index.length;
		for (const boundary of markers) {
			const offset = findIndexMarker(
				index,
				boundary,
				contentStart,
				unfencedOffsets,
			);
			if (offset >= 0) end = Math.min(end, offset);
		}
		entry.rationale = index.slice(contentStart, end).trim();
	}
	return true;
}

function findIndexMarker(
	index: string,
	marker: string,
	start: number,
	unfencedOffsets: Set<number>,
): number {
	let offset = index.indexOf(marker, start);
	while (offset >= 0) {
		if (unfencedOffsets.has(offset + 2)) return offset;
		offset = index.indexOf(marker, offset + marker.length);
	}
	return -1;
}

function parseDetail(
	text: string,
): { entry: IssueEntry; ambiguous: boolean } | undefined {
	text = text.replace(/\r\n/g, "\n");
	const header =
		/^---\nid: ([^\n]+)\nkind: ([^\n]+)\nlocation: ([^\n]+):(\d+)\n(?:entry: [^\n]*\n)?---\n\n# ([^\n]+)\n\n/.exec(
			text,
		);
	if (!header) return undefined;
	const body = text.slice(header[0].length);
	const { boundaries, unclosedFence } = scanMarkdown(body);
	const entry: IssueEntry = {
		id: header[1] ?? "",
		kind: header[2] ?? "",
		path: header[3] ?? "",
		line: Number(header[4]),
		headline: header[5] ?? "",
		rationale: "",
		context: "",
		evidence: "",
	};
	for (const { field } of PROSE_SECTIONS) {
		const position = boundaries.findIndex(
			(boundary) => boundary.field === field,
		);
		const boundary = boundaries[position];
		if (!boundary) continue;
		entry[field] = body
			.slice(boundary.end, boundaries[position + 1]?.start ?? body.length)
			.trim();
	}
	const expected = PROSE_SECTIONS.slice(0, boundaries.length);
	const ambiguous =
		unclosedFence ||
		boundaries.length < PROSE_SECTIONS.length - 1 ||
		boundaries.length > PROSE_SECTIONS.length ||
		boundaries[0]?.start !== 0 ||
		boundaries.some(
			(boundary, index) => boundary.field !== expected[index]?.field,
		);
	return { entry, ambiguous };
}

function scanMarkdown(text: string): {
	boundaries: MarkdownBoundary[];
	unclosedFence: boolean;
	unfencedOffsets: Set<number>;
} {
	const boundaries: MarkdownBoundary[] = [];
	const unfencedOffsets = new Set<number>();
	let fence: string | null = null;
	let offset = 0;
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (fence === null) unfencedOffsets.add(offset);
		const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const marker = delimiter?.[1] ?? "";
		const suffix = delimiter?.[2] ?? "";
		if (fence !== null) {
			if (
				marker[0] === fence[0] &&
				marker.length >= fence.length &&
				suffix.trim() === ""
			)
				fence = null;
		} else if (marker && (marker[0] !== "`" || !suffix.includes("`"))) {
			fence = marker;
		} else {
			const heading = /^ {0,3}##[ \t]+(.+?)\s*$/
				.exec(line)?.[1]
				?.replace(/[ \t]+#+$/, "");
			const section = PROSE_SECTIONS.find(
				(section) => section.heading === heading,
			);
			if (section)
				boundaries.push({
					field: section.field,
					start: offset,
					end: offset + line.length + 1,
				});
		}
		offset += line.length + 1;
	}
	return { boundaries, unclosedFence: fence !== null, unfencedOffsets };
}

function validateProse(id: string, changes: Partial<IssueEntry>): string[] {
	const violations: string[] = [];
	for (const { field } of PROSE_SECTIONS) {
		const content = changes[field];
		if (content === undefined) continue;
		const { boundaries, unclosedFence } = scanMarkdown(content.trim());
		for (const boundary of boundaries) {
			const section = PROSE_SECTIONS.find(
				(section) => section.field === boundary.field,
			);
			violations.push(
				`issue '${id}', field '${field}': conflicting heading '## ${section?.heading}' outside a fenced code block.`,
			);
		}
		if (unclosedFence)
			violations.push(
				`issue '${id}', field '${field}': unclosed code fence can obscure the next section.`,
			);
	}
	return violations;
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
		if (!Number.isSafeInteger(entry.line) || entry.line < 1) {
			violations.push(
				`invalid line for '${entry.id}': expected a positive safe integer.`,
			);
		}
		if (entry.headline.length === 0) {
			violations.push(
				`invalid headline for '${entry.id}': expected nonempty text.`,
			);
		}
		if (entry.headline.includes("\n") || entry.headline.includes("\r")) {
			violations.push(
				`invalid headline for '${entry.id}': expected a single line.`,
			);
		}
		if (entry.path.includes("\n") || entry.path.includes("\r")) {
			violations.push(
				`invalid path for '${entry.id}': expected a single line.`,
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
	if (a.path < b.path) return -1;
	if (a.path > b.path) return 1;
	if (a.line !== b.line) return a.line - b.line;
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return 0;
}

function buildIndex(entries: IssueEntry[], analyzedAt: string): string {
	const lines: string[] = ["---", `analyzed_at: ${analyzedAt}`, "counts:"];
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
	];
	for (const { field, heading } of PROSE_SECTIONS) {
		const content = entry[field]?.trim() ?? "";
		if (field === "notes" && !content) continue;
		lines.push("", `## ${heading}`, content);
	}
	return `${lines.join("\n")}\n`;
}

async function readFileMaybe(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (!isMissingFile(error)) throw error;
		return undefined;
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function indent(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => `  ${line}`)
		.join("\n");
}
