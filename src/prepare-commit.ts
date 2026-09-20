import { writeFile } from "node:fs/promises";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatGitFailure, runGit } from "./utils/git";

type ToolDetails = {
	readonly artifactPath: string | null;
};

const ARTIFACT_NAME = "PRECHECK_COMMIT_MSG";

const parameters = Type.Object({
	message: Type.String({
		minLength: 12,
		description:
			"Nonempty commit message to submit for the precommit artifact.",
	}),
});

export default function prepareCommit(pi: ExtensionAPI): void {
	pi.registerTool<typeof parameters, ToolDetails>({
		name: "prepare_commit",
		label: "Prepare Commit",
		description:
			"Submit a nonempty commit message to the precommit artifact in the Git directory.",
		parameters,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) =>
			await execute(params.message, ctx, signal),
	});
}

async function execute(
	message: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<ToolDetails>> {
	if (message.trim().length === 0) {
		return result("Error: Commit message cannot be empty.");
	}

	const artifactPathResult = await runGit(
		["rev-parse", "--path-format=absolute", "--git-path", ARTIFACT_NAME],
		ctx.cwd,
		signal,
	);
	if (artifactPathResult.exitCode !== 0) {
		return result(
			`Error: Cannot prepare a commit outside a Git worktree. ${formatGitFailure("rev-parse --git-path", artifactPathResult)}`,
		);
	}

	const artifactPath = artifactPathResult.stdout.trim();
	try {
		await writeFile(artifactPath, message, { encoding: "utf8", signal });
	} catch (error) {
		return result(
			`Error: Cannot write '${ARTIFACT_NAME}': ${errorMessage(error)}`,
		);
	}

	return result(`Commit message prepared at '${ARTIFACT_NAME}'.`, artifactPath);
}

function result(
	text: string,
	artifactPath: string | null = null,
): AgentToolResult<ToolDetails> {
	return {
		content: [{ type: "text", text }],
		details: { artifactPath },
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
