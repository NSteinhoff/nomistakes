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
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { errorMessage } from "./utils/error-message";
import { lstatOrNull } from "./utils/fs";

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

	try {
		const sourceStats = await lstatOrNull(sourcePath);
		if (sourceStats === null) {
			return textResult(`Delete failed: file does not exist: ${sourceInput}`);
		}
		if (sourceStats.isDirectory()) {
			return textResult(`Delete failed: '${sourceInput}' is a directory.`);
		}

		await rm(sourcePath);
		return textResult(`Deleted file: ${sourceInput}`);
	} catch (error) {
		return textResult(
			`Delete failed for '${sourceInput}': ${errorMessage(error)}`,
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

	try {
		const sourceStats = await lstatOrNull(sourcePath);
		if (sourceStats === null) {
			return textResult(
				`Move failed: source file does not exist: ${sourceInput}`,
			);
		}
		if (sourceStats.isDirectory()) {
			return textResult(`Move failed: '${sourceInput}' is a directory.`);
		}
	} catch (error) {
		return textResult(
			`Move failed for '${sourceInput}': ${errorMessage(error)}`,
		);
	}

	try {
		if ((await lstatOrNull(destinationPath)) !== null) {
			return textResult(
				`Move failed: destination already exists: ${destination}`,
			);
		}
	} catch (error) {
		return textResult(
			`Move failed for destination '${destination}': ${errorMessage(error)}`,
		);
	}

	try {
		await rename(sourcePath, destinationPath);
		return textResult(`Moved file: ${sourceInput} -> ${destination}`);
	} catch (error) {
		return textResult(
			`Move failed '${sourceInput}' -> '${destination}': ${errorMessage(error)}`,
		);
	}
}

function textResult(text: string): AgentToolResult<null> {
	return {
		content: [{ type: "text", text }],
		details: null,
	};
}

function renderCall(theme: Theme, toolCall: string) {
	return new Text(
		theme.fg("toolTitle", theme.bold("file operation ")) +
			theme.fg("accent", toolCall),
		0,
		0,
	);
}
