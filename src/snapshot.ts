/**
 * Creates per-turn Git snapshot commits using a temporary index.
 *
 * Invariants:
 * - Snapshot creation and inspection never modify the real working tree or
 *   user-owned index.
 * - Snapshots capture Git-visible working-tree content: tracked files plus
 *   non-ignored untracked files, not staged vs. unstaged state.
 * - Ignored files are outside snapshots and remain untouched by undo.
 * - Undo is command-only so the agent cannot invoke it as a tool.
 * - /review is command-only. It requests a defect review of user edits that
 *   accumulated since the last agent edit or review, tracked by reviewBaseline.
 */

import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	AgentEndEvent,
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatGitFailure, type GitResult, runGit } from "./utils/git";
import {
	buildExpandableOutput,
	type ExpandableOutputDetails,
	formatThemedExpandableOutput,
} from "./utils/tool-output";

type Snapshot = {
	readonly id: string;
	readonly commit: string;
	readonly tree: string;
	readonly repoRoot: string;
	readonly createdAt: number;
	readonly prompt: string;
};

type State = {
	turnStartSnapshot?: Snapshot;
	lastError?: string;
	// Baseline captured at the end of the previous turn. Compared against the
	// next turn-start snapshot to detect user edits made while the agent was
	// idle. Seeded at session_start so the first turn after resume reports
	// pre-prompt edits. Session-scoped only: never persisted, so a
	// garbage-collected commit can never leave a dangling cross-session reference.
	lastTurnEndSnapshot?: Snapshot;
	// From-point for /review: marks the last tree that held no unreviewed user
	// edits. Seeded at session_start so /review works before the first turn.
	// Advances (discarding pending edits) when the agent modifies files during a
	// turn or when a /review turn completes successfully. Held across non-editing
	// turns and across aborted reviews, so idle user edits accumulate as a clean
	// two-point diff (no agent edits interleave between advances). Session-scoped,
	// never persisted.
	reviewBaseline?: Snapshot;
	// Reviewed range endpoint for an in-flight /review turn. Set by /review,
	// consumed at agent_end: on successful completion it becomes the new
	// reviewBaseline; on abort/error it is discarded and the baseline holds so
	// the review can be restarted.
	reviewInProgress?: Snapshot;
};

type SnapshotResult =
	| { readonly ok: true; readonly snapshot: Snapshot }
	| { readonly ok: false; readonly error: string };

type ToolAction = NonNullable<Static<typeof toolParameters>["action"]>;

type SnapshotAction = ToolAction | "undo";

type ToolDetails = ExpandableOutputDetails & {
	readonly action: string;
	readonly error: boolean;
	readonly changed?: boolean;
	readonly turnStartSnapshot?: Snapshot;
	readonly liveSnapshotCommit?: string;
};

const DESCRIPTION = [
	"Create and inspect per-turn Git object snapshots without modifying the real index or working tree.",
	"Snapshots capture Git-visible working-tree content: tracked files plus non-ignored untracked files.",
	"Ignored files are excluded, and undo leaves them untouched.",
	"Use action=diff for self-review of Git-visible content changed during this agent turn. Prefer this over staged or unstaged git diffs.",
	"For branch state, commit history, or repository-wide inspection, use the status tool instead.",
	"Snapshots are commit objects built with a temporary index via GIT_INDEX_FILE and are garbage-collectable if unreferenced.",
	"Undo is intentionally command-only. The snapshot tool cannot invoke it.",
];

// Deterministic identity so snapshot creation never depends on the repo's
// configured user.name/user.email; commit-tree otherwise fails when no
// committer identity is set.
const SNAPSHOT_IDENTITY: Readonly<Record<string, string>> = {
	GIT_AUTHOR_NAME: "pi snapshot",
	GIT_AUTHOR_EMAIL: "pi-snapshot@localhost",
	GIT_COMMITTER_NAME: "pi snapshot",
	GIT_COMMITTER_EMAIL: "pi-snapshot@localhost",
};

// Collapse displayed snapshot messages to this many lines unless expanded,
// matching the turn-snapshot tool's own result rendering.
const SNAPSHOT_RENDER_MAX_LINES = 32;

// Detail payload for displayed snapshot messages. A collapsedLabel opts the
// message into a single-line collapsed presentation (label plus expand hint),
// mirroring the branch-summary component; the full content renders only when
// expanded. Messages without it keep the default multi-line preview.
type SnapshotMessageDetails = {
	readonly collapsedLabel?: string;
};

const toolParameters = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("summary"), Type.Literal("diff")], {
			description:
				"Action to run. summary reports turn-start snapshot status. diff compares the turn-start snapshot to a live snapshot.",
		}),
	),
});

export default function turnSnapshot(pi: ExtensionAPI): void {
	const state: State = {};

	// Seed a checkpoint when a session starts, loads, or reloads so /review and
	// the inter-turn awareness notice work before the first agent turn: without
	// it, reviewBaseline is unset until the first agent_end and pre-prompt user
	// edits go untracked. Idempotent (only seeds unset baselines) so a session
	// that already accumulated unreviewed edits is never reset. On snapshot
	// failure both baselines stay unset and the agent_end lazy init remains the
	// fallback for reviewBaseline.
	pi.on("session_start", async (event, ctx) => {
		if (state.reviewBaseline !== undefined) return;
		const result = await createSnapshot(
			ctx.cwd,
			`session checkpoint (${event.reason})`,
			ctx.signal,
		);
		if (!result.ok) return;
		state.reviewBaseline = result.snapshot;
		state.lastTurnEndSnapshot ??= result.snapshot;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const previousTurnEnd = state.lastTurnEndSnapshot;

		const result = await createSnapshot(ctx.cwd, event.prompt, ctx.signal);
		if (!result.ok) {
			state.turnStartSnapshot = undefined;
			state.lastError = result.error;
			return;
		}
		state.turnStartSnapshot = result.snapshot;
		state.lastError = undefined;

		const notice = await buildInterTurnNotice(
			previousTurnEnd,
			result.snapshot,
			ctx.signal,
		);
		if (notice) {
			return {
				message: {
					customType: "snapshot",
					content: notice,
					display: true,
					details: {
						collapsedLabel: "Inter-turn edits",
					} satisfies SnapshotMessageDetails,
				},
			};
		}
	});

	// Capture Git-visible working-tree content at turn end so the next turn-start
	// can detect covered inter-turn user edits. A failed capture clears the
	// baseline rather than leaving a stale one.
	//
	// Also advance reviewBaseline: on a /review turn only when the review
	// completed (not aborted or errored), to the reviewed endpoint; otherwise when
	// the agent modified files this turn (turn-start tree differs from turn-end
	// tree), discarding pending user edits now entangled with agent edits; and
	// initialize it on the first successful capture.
	pi.on("agent_end", async (event, ctx) => {
		const result = await createSnapshot(
			ctx.cwd,
			"turn-end baseline",
			ctx.signal,
		);
		if (!result.ok) {
			state.lastTurnEndSnapshot = undefined;
			// Drop any in-flight review marker: without an end snapshot the baseline
			// cannot advance, and leaving it set would misattribute a later turn as
			// the review's completion.
			state.reviewInProgress = undefined;
			return;
		}
		const endSnapshot = result.snapshot;
		state.lastTurnEndSnapshot = endSnapshot;

		// A /review turn advances the baseline only on successful completion. An
		// aborted or errored review leaves reviewBaseline intact so the same delta
		// can be reviewed again. Advancing to the reviewed endpoint (not the
		// turn-end tree) keeps edits made during the review unreviewed.
		const reviewTarget = state.reviewInProgress;
		if (reviewTarget !== undefined) {
			state.reviewInProgress = undefined;
			if (
				!runInterrupted(event.messages) &&
				reviewTarget.repoRoot === endSnapshot.repoRoot
			) {
				state.reviewBaseline = reviewTarget;
			}
			return;
		}

		const start = state.turnStartSnapshot;
		const implementationTurn =
			start !== undefined &&
			start.repoRoot === endSnapshot.repoRoot &&
			start.tree !== endSnapshot.tree;
		if (implementationTurn || state.reviewBaseline === undefined) {
			state.reviewBaseline = endSnapshot;
		}
	});

	pi.registerTool<typeof toolParameters, ToolDetails>({
		name: "snapshot",
		label: "Turn Snapshot",
		description: DESCRIPTION.join(" "),
		promptSnippet:
			"Create and inspect per-turn Git object snapshots of Git-visible working-tree content for current-turn self-review.",
		parameters: toolParameters,
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("snapshot ")) +
					theme.fg("accent", args.action?.trim() || "summary"),
				0,
				0,
			);
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
			return await executeAction(
				params.action ?? "summary",
				state,
				ctx,
				signal,
			);
		},
	});

	// Custom messages render fully expanded by default. Reuse the tool-result
	// collapse/expand contract so long notices (chiefly /review diffs) truncate
	// to a preview with an expand toggle. The customBgFn restores the standard
	// custom-message background (padding 1,1 + customMessageBg) that the default
	// renderer applies via a Box, so these messages stay visually distinct.
	// Non-string content (none today) falls through to default rendering.
	//
	// A collapsedLabel detail opts the message into a single-line collapsed
	// header (label plus expand hint) like the branch-summary component, used by
	// the inter-turn awareness notice so idle user edits stay unobtrusive until
	// expanded. Messages without it (chiefly /review diffs) keep the preview.
	pi.registerMessageRenderer<SnapshotMessageDetails>(
		"snapshot",
		(message, options, theme) => {
			if (typeof message.content !== "string") return undefined;
			const collapsedLabel = message.details?.collapsedLabel;
			if (collapsedLabel && !options.expanded) {
				return new Text(
					theme.fg("customMessageText", `${collapsedLabel} (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					1,
					1,
					(line) => theme.bg("customMessageBg", line),
				);
			}
			return new Text(
				formatThemedExpandableOutput(
					{ fullText: message.content },
					options.expanded,
					theme,
					SNAPSHOT_RENDER_MAX_LINES,
				),
				1,
				1,
				(line) => theme.bg("customMessageBg", line),
			);
		},
	);

	pi.registerCommand("review", {
		description:
			"Review user edits accumulated since the last agent change or review",
		handler: async (_args, ctx) => {
			await runReview(pi, state, ctx);
		},
	});

	pi.registerCommand("undo", {
		description:
			"Restore Git-visible content to the turn-start snapshot; ignored files stay untouched",
		handler: async (_args, ctx) => {
			await runCommand(pi, "undo", state, ctx);
		},
	});
}

// A run that ends with an aborted or errored assistant message did not complete
// normally. Used to hold the review baseline so an interrupted /review can be
// restarted. A run carrying no assistant message is treated as interrupted.
function runInterrupted(messages: AgentEndEvent["messages"]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return message.stopReason === "aborted" || message.stopReason === "error";
		}
	}
	return true;
}

// User-pulled trigger. Cheaply gates on the review baseline and a live tree
// delta so an empty review never spawns a turn, then emits the review notice as
// a single self-contained custom message and triggers the review turn. Building
// the diff here keeps the directive and its patch in one entry rather than
// splitting them across a user message and a turn-start notice.
async function runReview(
	pi: ExtensionAPI,
	state: State,
	ctx: ExtensionContext,
): Promise<void> {
	const baseline = state.reviewBaseline;
	if (!baseline) {
		ctx.ui.notify(
			"No review baseline yet. Send a prompt first to establish one.",
			"warning",
		);
		return;
	}
	const live = await createSnapshot(ctx.cwd, "review guard", ctx.signal);
	if (!live.ok) {
		ctx.ui.notify(live.error, "warning");
		return;
	}
	if (live.snapshot.repoRoot !== baseline.repoRoot) {
		ctx.ui.notify(
			`Snapshot repo changed since the review baseline; cannot review. Baseline repo: ${baseline.repoRoot}; live repo: ${live.snapshot.repoRoot}`,
			"warning",
		);
		return;
	}
	if (live.snapshot.tree === baseline.tree) {
		ctx.ui.notify(
			"No user edits to review since the last agent change or review.",
			"info",
		);
		return;
	}
	const notice = await buildReviewNotice(baseline, live.snapshot, ctx.signal);
	if (!notice) {
		ctx.ui.notify(
			"Cannot build the review notice for the accumulated edits.",
			"warning",
		);
		return;
	}
	// Advance the review baseline only after a completed review. An aborted review
	// leaves the delta intact for a restart.
	state.reviewInProgress = live.snapshot;
	// `sendMessage` triggers an agent response without `before_agent_start`.
	// Do not suppress the next user prompt's inter-turn notice.
	pi.sendMessage(
		{ customType: "snapshot", content: notice, display: true },
		{ triggerTurn: true },
	);
}

async function runCommand(
	pi: ExtensionAPI,
	action: SnapshotAction,
	state: State,
	ctx: ExtensionContext,
): Promise<void> {
	const result = await executeAction(action, state, ctx);
	ctx.ui.notify(
		result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n"),
		result.details.error ? "warning" : "info",
	);
	if (!result.details.error && result.details.changed && action === "undo") {
		announceRestore(pi);
	}
}

// A manual undo silently mutates Git-visible working-tree content, so the
// agent's record of its own edits goes stale. Deliver context next turn
// (without triggering one) so the agent re-reads files instead of trusting that
// record.
function announceRestore(pi: ExtensionAPI): void {
	pi.sendMessage(
		{
			customType: "snapshot",
			content:
				"The user manually ran /undo. Git-visible working-tree content was restored to the snapshot taken at the start of the previous turn, undoing covered edits from that turn. Ignored files were outside the snapshot and remain untouched. Re-read snapshot-covered files before relying on earlier changes.",
			display: true,
		},
		{ deliverAs: "nextTurn" },
	);
}

async function executeAction(
	action: SnapshotAction,
	state: State,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<ToolDetails>> {
	if (!state.turnStartSnapshot) {
		const reason = state.lastError
			? `No turn-start snapshot is available. Last snapshot error: ${state.lastError}`
			: "No turn-start snapshot is available. Send a new agent prompt to capture one.";
		return textResult(reason, action, true);
	}

	switch (action) {
		case "summary": {
			return textResult(
				formatSnapshotSummary(state.turnStartSnapshot),
				action,
				false,
				{
					turnStartSnapshot: state.turnStartSnapshot,
				},
			);
		}

		case "diff": {
			const live = await createSnapshot(
				ctx.cwd,
				"turn snapshot diff live snapshot",
				signal,
			);
			if (!live.ok) return textResult(live.error, action, true);
			if (live.snapshot.repoRoot !== state.turnStartSnapshot.repoRoot) {
				return textResult(
					`Snapshot repo changed. Turn-start snapshot repo: ${state.turnStartSnapshot.repoRoot}; live snapshot repo: ${live.snapshot.repoRoot}`,
					action,
					true,
				);
			}
			const diff = await git(
				[
					"diff",
					"--find-renames",
					"--stat",
					state.turnStartSnapshot.commit,
					live.snapshot.commit,
				],
				state.turnStartSnapshot.repoRoot,
				signal,
			);
			if (diff.exitCode !== 0) {
				return textResult(formatGitFailure("diff --stat", diff), action, true);
			}
			const patch = await git(
				[
					"diff",
					"--find-renames",
					state.turnStartSnapshot.commit,
					live.snapshot.commit,
				],
				state.turnStartSnapshot.repoRoot,
				signal,
			);
			if (patch.exitCode !== 0) {
				return textResult(formatGitFailure("diff", patch), action, true);
			}
			const output = [
				"Turn snapshot diff",
				`Turn-start snapshot: ${state.turnStartSnapshot.commit}`,
				`Live snapshot:       ${live.snapshot.commit}`,
				`Repo:                ${state.turnStartSnapshot.repoRoot}`,
				"Scope:               Git-visible working-tree content (tracked files plus non-ignored untracked files); ignored files excluded.",
				"",
				"Stat:",
				diff.stdout.trim() || "(no changes)",
				"",
				"Patch:",
				patch.stdout.trim() || "(no changes)",
			].join("\n");
			return textResult(output, action, false, {
				turnStartSnapshot: state.turnStartSnapshot,
				liveSnapshotCommit: live.snapshot.commit,
			});
		}

		case "undo": {
			if (!ctx.hasUI) {
				return textResult(
					"Undo requires interactive UI confirmation.",
					action,
					true,
				);
			}
			const ok = await ctx.ui.confirm(
				"Undo to turn-start snapshot?",
				"Restore Git-visible working-tree content (tracked files plus non-ignored untracked files) to the turn-start snapshot. Ignored files are outside the snapshot and remain untouched. The real Git index is not modified, but staged entries may differ from restored files afterward.",
			);
			if (!ok) return textResult("Undo cancelled.", action, true);

			const restore = await restoreToSnapshot(
				state.turnStartSnapshot,
				ctx.cwd,
				signal,
			);
			if (!restore.ok) return textResult(restore.error, action, true);
			const message = restore.changed
				? [
						"Restored Git-visible working-tree content to the turn-start snapshot.",
						`Turn-start snapshot: ${state.turnStartSnapshot.commit}`,
						`Live snapshot before undo: ${restore.liveSnapshot.commit}`,
						"Ignored files were outside the snapshot and remain untouched.",
						"The real Git index was not updated.",
					].join("\n")
				: "Git-visible working-tree content already matches the turn-start snapshot; nothing to undo. Ignored files were not compared and remain untouched.";
			return textResult(message, action, false, {
				changed: restore.changed,
				turnStartSnapshot: state.turnStartSnapshot,
				liveSnapshotCommit: restore.liveSnapshot.commit,
			});
		}

		default: {
			const _x: never = action;

			return textResult(
				`Unsupported action '${action}'. Use summary, diff, or undo.`,
				action,
				true,
			);
		}
	}
}

async function createSnapshot(
	cwd: string,
	prompt: string,
	signal?: AbortSignal,
): Promise<SnapshotResult> {
	try {
		const repoRootResult = await git(
			["rev-parse", "--show-toplevel"],
			cwd,
			signal,
		);
		if (repoRootResult.exitCode !== 0) {
			return {
				ok: false,
				error: `Cannot create turn snapshot outside a Git worktree. ${formatGitFailure("rev-parse --show-toplevel", repoRootResult)}`,
			};
		}
		const repoRoot = repoRootResult.stdout.trim();
		const realIndexPathResult = await git(
			["rev-parse", "--git-path", "index"],
			repoRoot,
			signal,
		);
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
			buildSnapshotCommit(
				repoRoot,
				realIndexPath,
				tempIndexPath,
				prompt,
				signal,
			),
		);
	} catch (error) {
		return {
			ok: false,
			error: `Failed to create turn snapshot: ${errorMessage(error)}`,
		};
	}
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

async function buildSnapshotCommit(
	repoRoot: string,
	realIndexPath: string,
	tempIndexPath: string,
	prompt: string,
	signal?: AbortSignal,
): Promise<SnapshotResult> {
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

	// Respect Git ignore rules: include tracked files and non-ignored untracked
	// files while leaving ignored files outside the snapshot.
	const addResult = await gitWithTempIndex(
		["add", "-A"],
		repoRoot,
		tempIndexPath,
		signal,
	);
	if (addResult.exitCode !== 0) {
		return { ok: false, error: formatGitFailure("add -A", addResult) };
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
	const headResult = await git(
		["rev-parse", "--verify", "HEAD"],
		repoRoot,
		signal,
	);
	const commitArgs = ["commit-tree", tree];
	if (headResult.exitCode === 0) {
		commitArgs.push("-p", headResult.stdout.trim());
	}
	const commitResult = await runGit(
		commitArgs,
		repoRoot,
		signal,
		SNAPSHOT_IDENTITY,
		"pi turn snapshot\n",
	);
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
			prompt,
		},
	};
}

// Builds the invisible turn-start notice describing user edits made between the
// previous turn's end and this turn's start. Change detection compares tree
// hashes by string equality, so it holds even if the objects were pruned. The
// diff detail dereferences the previous commit and therefore degrades
// gracefully when git has garbage-collected it.
async function buildInterTurnNotice(
	previous: Snapshot | undefined,
	current: Snapshot,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!previous) return undefined;
	if (previous.repoRoot !== current.repoRoot) return undefined;
	if (previous.tree === current.tree) return undefined;

	const lines = [
		"Inter-turn change detected: Git-visible working-tree content (tracked files plus non-ignored untracked files) changed between the end of the previous turn and the start of this turn, i.e. user edits made while the agent was idle.",
		`Previous turn-end snapshot: ${previous.commit}`,
		`Current turn-start snapshot: ${current.commit}`,
		"Ignored files are outside snapshots and are not covered by this notice.",
		"Treat the current Git-visible working-tree content as the baseline. Re-read affected files before relying on earlier context.",
	];

	const section = await buildSnapshotDiffSection(previous, current, signal);
	if (!section.available) {
		lines.push("", `Diff detail unavailable: ${section.reason}`);
		return lines.join("\n");
	}
	appendDiffSection(lines, section);
	return lines.join("\n");
}

// Builds the visible /review notice describing user edits accumulated since
// reviewBaseline. Unlike the awareness notice it always renders (the command
// already confirmed a delta) and steers the agent to a read-only defect review.
async function buildReviewNotice(
	baseline: Snapshot | undefined,
	current: Snapshot,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!baseline) return undefined;
	if (baseline.repoRoot !== current.repoRoot) {
		return `Requested review unavailable: snapshot repo changed. Baseline repo: ${baseline.repoRoot}; current repo: ${current.repoRoot}`;
	}

	const lines = [
		"Requested user-edit review: the Git-visible changes below accumulated since the last agent edit or review and are the review target.",
		`Review baseline:  ${baseline.commit}`,
		`Current snapshot: ${current.commit}`,
		"Ignored files are outside snapshots and excluded.",
		"Perform a defect review of these edits (correctness, regressions, security, and inconsistencies) and report findings concisely. This is read-only. Do not modify files. Do not delegate.",
	];

	if (baseline.tree === current.tree) {
		lines.push("", "No changes to review.");
		return lines.join("\n");
	}
	const section = await buildSnapshotDiffSection(baseline, current, signal);
	if (!section.available) {
		lines.push("", `Diff detail unavailable: ${section.reason}`);
		return lines.join("\n");
	}
	appendDiffSection(lines, section);
	return lines.join("\n");
}

type DiffSection =
	| { readonly available: true; readonly stat: string; readonly patch: string }
	| { readonly available: false; readonly reason: string };

// Shared stat+patch builder for both notices. Dereferences `from`, so it
// degrades gracefully when git has garbage-collected that commit.
async function buildSnapshotDiffSection(
	from: Snapshot,
	to: Snapshot,
	signal?: AbortSignal,
): Promise<DiffSection> {
	const exists = await git(
		["cat-file", "-e", from.commit],
		to.repoRoot,
		signal,
	);
	if (exists.exitCode !== 0) {
		return {
			available: false,
			reason: "the baseline snapshot object was pruned by git.",
		};
	}
	const stat = await git(
		["diff", "--find-renames", "--stat", from.commit, to.commit],
		to.repoRoot,
		signal,
	);
	if (stat.exitCode !== 0) {
		return { available: false, reason: formatGitFailure("diff --stat", stat) };
	}
	const patch = await git(
		["diff", "--find-renames", from.commit, to.commit],
		to.repoRoot,
		signal,
	);
	if (patch.exitCode !== 0) {
		return { available: false, reason: formatGitFailure("diff", patch) };
	}
	return {
		available: true,
		stat: stat.stdout.trim(),
		patch: patch.stdout.trim(),
	};
}

// Appends changed-files and patch blocks. The patch is bounded by
// buildExpandableOutput: a large diff is truncated to a head slice with a
// spill-file pointer for full recovery via `read`.
function appendDiffSection(
	lines: string[],
	section: Extract<DiffSection, { available: true }>,
): void {
	lines.push("", "Changed files:", section.stat || "(no file-level changes)");
	if (section.patch) {
		lines.push("", "Patch:", buildExpandableOutput(section.patch).contentText);
	}
}

async function restoreToSnapshot(
	target: Snapshot,
	cwd: string,
	signal?: AbortSignal,
): Promise<
	| {
			readonly ok: true;
			readonly changed: boolean;
			readonly liveSnapshot: Snapshot;
	  }
	| { readonly ok: false; readonly error: string }
> {
	const live = await createSnapshot(
		cwd,
		"turn snapshot restore live snapshot",
		signal,
	);
	if (!live.ok) return live;
	if (live.snapshot.repoRoot !== target.repoRoot) {
		return {
			ok: false,
			error: `Snapshot repo changed. Target snapshot repo: ${target.repoRoot}; live snapshot repo: ${live.snapshot.repoRoot}`,
		};
	}

	const patch = await git(
		["diff", "--binary", "--find-renames", live.snapshot.commit, target.commit],
		target.repoRoot,
		signal,
	);
	if (patch.exitCode !== 0) {
		return { ok: false, error: formatGitFailure("diff --binary", patch) };
	}
	if (!patch.stdout.trim()) {
		return { ok: true, changed: false, liveSnapshot: live.snapshot };
	}

	// `git apply` without --index/--cached neither reads nor writes the index,
	// so the restore needs no temporary index; the patch lands in the working
	// tree only. Ignored files are absent from snapshots and therefore from the
	// patch, so they remain untouched.
	const applyResult = await gitWithInput(
		["apply", "--binary", "--whitespace=nowarn", "-"],
		target.repoRoot,
		patch.stdout,
		signal,
	);
	if (applyResult.exitCode !== 0) {
		return {
			ok: false,
			error: formatGitFailure("apply --binary", applyResult),
		};
	}
	return { ok: true, changed: true, liveSnapshot: live.snapshot };
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function gitWithTempIndex(
	args: readonly string[],
	cwd: string,
	tempIndexPath: string,
	signal?: AbortSignal,
): Promise<GitResult> {
	return await git(args, cwd, signal, {
		GIT_INDEX_FILE: tempIndexPath,
	});
}

async function gitWithInput(
	args: readonly string[],
	cwd: string,
	input: string,
	signal?: AbortSignal,
): Promise<GitResult> {
	return await runGit(args, cwd, signal, {}, input);
}

async function git(
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
	env: Readonly<Record<string, string>> = {},
): Promise<GitResult> {
	return await runGit(args, cwd, signal, env);
}

function formatSnapshotSummary(snapshot: Snapshot): string {
	return [
		"Turn-start snapshot",
		`Commit:  ${snapshot.commit}`,
		`Repo:    ${snapshot.repoRoot}`,
		`Created: ${new Date(snapshot.createdAt).toISOString()}`,
		`Prompt:  ${snapshot.prompt.slice(0, 200)}`,
		"Scope:   Git-visible working-tree content (tracked files plus non-ignored untracked files); ignored files are excluded.",
		"",
		"Use action=diff to compare the turn-start snapshot to a live snapshot without inspecting staged diffs.",
	].join("\n");
}

function textResult(
	text: string,
	action: string,
	isError = false,
	extra: Partial<
		Pick<ToolDetails, "changed" | "turnStartSnapshot" | "liveSnapshotCommit">
	> = {},
): AgentToolResult<ToolDetails> {
	const { contentText, details } = buildExpandableOutput(text);
	return {
		content: [{ type: "text", text: contentText }],
		details: {
			...details,
			action,
			error: isError,
			...extra,
		},
	};
}
