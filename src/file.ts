/**
 * file tools (Pi harness port)
 *
 * Purpose:
 * - move_file: move or rename a single file.
 * - delete_file: delete a single file.
 *
 * Move behavior policy:
 * - Move does not create destination parent directories.
 * - Missing destination parent directories are treated as an error by design.
 */
import { lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const moveParameters = Type.Object({
	path: Type.String({
		description: "Source file path (relative to cwd unless absolute).",
	}),
	destination: Type.String({
		description: "Destination path.",
	}),
});

const deleteParameters = Type.Object({
	path: Type.String({
		description: "File path to delete (relative to cwd unless absolute).",
	}),
});

export type MoveFileToolInput = Static<typeof moveParameters>;
export type DeleteFileToolInput = Static<typeof deleteParameters>;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "move_file",
		label: "Move File",
		description: "Move or rename a file.",
		parameters: moveParameters,
		// Mutates the filesystem via check-then-act (lstat then rename);
		// concurrent file ops on overlapping paths would race.
		executionMode: "sequential",
		renderCall(args, theme) {
			const destination = args.destination?.trim() || "(missing destination)";
			return renderCall(theme, `move ${args.path} -> ${destination}`);
		},
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			return await moveFile(ctx, params.path, params.destination);
		},
	});

	pi.registerTool({
		name: "delete_file",
		label: "Delete File",
		description: "Delete a file.",
		promptSnippet: "Delete a file.",
		promptGuidelines: [
			"Use 'delete_file' only for intentional removals; do not use it for content edits.",
		],
		parameters: deleteParameters,
		// Mutates the filesystem via check-then-act (lstat then rm).
		executionMode: "sequential",
		renderCall(args, theme) {
			return renderCall(theme, `delete ${args.path}`);
		},
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			return await deleteFile(ctx, params.path);
		},
	});
}

async function deleteFile(
	ctx: ExtensionContext,
	pathInput: string,
): Promise<AgentToolResult<null>> {
	const sourceInput = pathInput.trim();
	if (!sourceInput) return textResult("'path' cannot be empty.");
	const sourcePath = path.resolve(ctx.cwd, sourceInput);

	const sourceStats = await safeLstat(sourcePath);
	if (sourceStats.error) {
		return textResult(
			`Delete failed for '${sourceInput}': ${sourceStats.error.message}`,
		);
	}
	if (!sourceStats.exists) {
		return textResult(`Delete failed: file does not exist: ${sourceInput}`);
	}
	if (sourceStats.stats?.isDirectory()) {
		return textResult(`Delete failed: '${sourceInput}' is a directory.`);
	}

	try {
		await rm(sourcePath);
		return textResult(`Deleted file: ${sourceInput}`);
	} catch (error) {
		return textResult(
			`Delete failed for '${sourceInput}': ${(error as Error).message}`,
		);
	}
}

async function moveFile(
	ctx: ExtensionContext,
	pathInput: string,
	destinationInput: string,
): Promise<AgentToolResult<null>> {
	const sourceInput = pathInput.trim();
	if (!sourceInput) return textResult("'path' cannot be empty.");
	const sourcePath = path.resolve(ctx.cwd, sourceInput);

	const destination = destinationInput?.trim() || "";
	if (!destination) return textResult("'destination' is required.");
	const destinationPath = path.resolve(ctx.cwd, destination);

	const sourceStats = await safeLstat(sourcePath);
	if (sourceStats.error) {
		return textResult(
			`Move failed for '${sourceInput}': ${sourceStats.error.message}`,
		);
	}
	if (!sourceStats.exists) {
		return textResult(
			`Move failed: source file does not exist: ${sourceInput}`,
		);
	}
	if (sourceStats.stats?.isDirectory()) {
		return textResult(`Move failed: '${sourceInput}' is a directory.`);
	}

	const destinationStats = await safeLstat(destinationPath);
	if (destinationStats.error) {
		return textResult(
			`Move failed for destination '${destination}': ${destinationStats.error.message}`,
		);
	}
	if (destinationStats.exists) {
		return textResult(
			`Move failed: destination already exists: ${destination}`,
		);
	}

	try {
		await rename(sourcePath, destinationPath);
		return textResult(`Moved file: ${sourceInput} -> ${destination}`);
	} catch (error) {
		return textResult(
			`Move failed '${sourceInput}' -> '${destination}': ${(error as Error).message}`,
		);
	}
}

function textResult(text: string): AgentToolResult<null> {
	return {
		content: [{ type: "text", text }],
		details: null,
	};
}

async function safeLstat(target: string): Promise<{
	exists: boolean;
	stats?: Awaited<ReturnType<typeof lstat>>;
	error?: Error;
}> {
	try {
		const stats = await lstat(target);
		return { exists: true, stats };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { exists: false };
		}
		return { exists: false, error: error as Error };
	}
}

function renderCall(theme: Theme, toolCall: string) {
	return new Text(
		theme.fg("toolTitle", theme.bold("file operation ")) +
			theme.fg("accent", toolCall),
		0,
		0,
	);
}
