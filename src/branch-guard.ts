/**
 * Branch Guard extension.
 *
 * Associates each conversation turn with the git branch it ran on, then warns
 * when work continues on a different branch than the last recorded turn.
 *
 * Mechanics:
 * - Records the current git branch per user turn as a CustomEntry. Custom
 *   entries are tree-scoped and never sent to the LLM, so the association
 *   survives restart / resume and stays correct per conversation branch.
 * - Warns (blocking confirm) before a new user message runs on a branch that
 *   differs from the last recorded turn on the active path; declining drops the
 *   message.
 *
 * /tree navigation needs no handler: the input guard reads the recorded branch
 * from the live active path on every message, so switching conversation
 * branches automatically recovers the right baseline for the next message.
 *
 * Detached HEAD and non-git worktrees have no branch name, so they are skipped
 * silently: no record and no warning.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runGit } from "./utils/git";

const CUSTOM_TYPE = "branch-guard";

type BranchData = {
	readonly branch: string;
};

// Session data is `unknown` (possibly an older schema), so validate the shape
// at the boundary before trusting it.
function parseBranchData(value: unknown): BranchData | null {
	if (typeof value !== "object" || value === null) return null;
	const data = value as Record<string, unknown>;
	if (typeof data.branch !== "string" || data.branch.length === 0) return null;
	return { branch: data.branch };
}

// Most recent branch recorded on the active path, or undefined if none.
// getBranch() yields root -> leaf order, so the last match wins.
function lastRecordedBranch(ctx: ExtensionContext): string | undefined {
	let branch: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		const data = parseBranchData(entry.data);
		if (data) branch = data.branch;
	}
	return branch;
}

// Current checked-out branch, or undefined on detached HEAD / non-git worktree.
async function currentBranch(
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await runGit({
		args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
		cwd,
		signal,
	});
	if (result.exitCode !== 0) return undefined;
	const branch = result.stdout.trim();
	return branch.length > 0 ? branch : undefined;
}

export default function branchGuard(pi: ExtensionAPI): void {
	// New user message: block on branch mismatch. This is the only hook that can
	// cancel a turn (before_agent_start cannot), so the warning lives here.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !ctx.hasUI) {
			return { action: "continue" };
		}

		const current = await currentBranch(ctx.cwd, ctx.signal);
		if (current === undefined) return { action: "continue" };

		const recorded = lastRecordedBranch(ctx);
		if (recorded === undefined || recorded === current) {
			return { action: "continue" };
		}

		const proceed = await ctx.ui.confirm(
			"Branch mismatch",
			`Working tree is on git branch "${current}", but this session's last turn ran on "${recorded}". Proceed on "${current}"?`,
		);
		if (proceed) return { action: "continue" };

		ctx.ui.notify(
			"Message cancelled. Switch branches or resend to proceed.",
			"info",
		);
		return { action: "handled" };
	});

	// Record the branch for the turn that is about to run. Append only on change
	// so a run of turns on one branch leaves a single entry per switch. The
	// mismatch warning already fired in the input hook.
	pi.on("before_agent_start", async (_event, ctx) => {
		const current = await currentBranch(ctx.cwd, ctx.signal);
		if (current === undefined) return;
		if (lastRecordedBranch(ctx) === current) return;
		pi.appendEntry<BranchData>(CUSTOM_TYPE, { branch: current });
	});
}
