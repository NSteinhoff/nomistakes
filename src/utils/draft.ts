import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { gitOutput } from "./git";
import {
	PATCH_DIRECTORY,
	preparePatchDirectory,
	writeFileAtomic,
} from "./worktree";

export const DRAFT_PREFIX = "Draft";
export const DRAFT_SUFFIX = "Draft it!";
export const PATCH_TOOL = "create_patch";
const MAX_FILES = 20;
const MAX_EDITS = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const PATCH_CONTEXT = 3;

export const patchParameters = Type.Object({
	name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 60 }),
	files: Type.Array(
		Type.Object({
			path: Type.String({
				description: "Path relative to cwd to an existing text file.",
			}),
			edits: Type.Array(
				Type.Object({
					oldText: Type.String({ minLength: 1 }),
					newText: Type.String(),
				}),
				{ minItems: 1, maxItems: MAX_EDITS },
			),
		}),
		{ minItems: 1, maxItems: MAX_FILES },
	),
});

export type PatchFile = {
	readonly path: string;
	readonly edits: readonly {
		readonly oldText: string;
		readonly newText: string;
	}[];
};

export function isDraftPrompt(text: string): boolean {
	const prompt = text.trim();
	return (
		prompt === DRAFT_PREFIX ||
		prompt.startsWith(`${DRAFT_PREFIX} `) ||
		prompt.startsWith(`${DRAFT_PREFIX}:`) ||
		prompt.startsWith(`${DRAFT_PREFIX}\n`) ||
		prompt.endsWith(DRAFT_SUFFIX)
	);
}

function replaceText(source: string, edits: PatchFile["edits"]): string {
	const replacements = edits
		.map((edit) => {
			const start = source.indexOf(edit.oldText);
			if (start < 0 || source.indexOf(edit.oldText, start + 1) >= 0) {
				throw new Error(
					"Each oldText must match exactly once in the original file.",
				);
			}
			return { ...edit, start, end: start + edit.oldText.length };
		})
		.sort((left, right) => left.start - right.start);
	let cursor = 0;
	let result = "";
	for (const replacement of replacements) {
		if (replacement.start < cursor) throw new Error("Edits must not overlap.");
		result += source.slice(cursor, replacement.start) + replacement.newText;
		cursor = replacement.end;
	}
	return result + source.slice(cursor);
}

function diffLines(text: string): string[] {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	return lines;
}

function patchLine(prefix: string, line: string): string {
	return `${prefix}${line}${line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"}`;
}

function fileDiff(file: string, source: string, target: string): string {
	if (source === target) return "";
	const before = diffLines(source);
	const after = diffLines(target);
	let prefix = 0;
	while (
		prefix < Math.min(before.length, after.length) &&
		before[prefix] === after[prefix]
	)
		prefix++;
	let suffix = 0;
	while (
		suffix < Math.min(before.length, after.length) - prefix &&
		before[before.length - suffix - 1] === after[after.length - suffix - 1]
	)
		suffix++;
	const start = Math.max(0, prefix - PATCH_CONTEXT);
	const contextEnd = Math.min(suffix, PATCH_CONTEXT);
	const beforeEnd = before.length - suffix + contextEnd;
	const afterEnd = after.length - suffix + contextEnd;
	const beforeCount = beforeEnd - start;
	const afterCount = afterEnd - start;
	const sourcePath = JSON.stringify(`a/${file}`);
	const targetPath = JSON.stringify(`b/${file}`);
	let patch = `diff --git ${sourcePath} ${targetPath}\n--- ${sourcePath}\n+++ ${targetPath}\n`;
	patch += `@@ -${beforeCount === 0 ? start : start + 1},${beforeCount} +${afterCount === 0 ? start : start + 1},${afterCount} @@\n`;
	for (const line of before.slice(start, prefix)) patch += patchLine(" ", line);
	for (const line of before.slice(prefix, before.length - suffix))
		patch += patchLine("-", line);
	for (const line of after.slice(prefix, after.length - suffix))
		patch += patchLine("+", line);
	for (const line of before.slice(before.length - suffix, beforeEnd))
		patch += patchLine(" ", line);
	return patch;
}

async function readSource(root: string, file: string): Promise<string> {
	if (
		Array.from(file).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) ||
		file.includes("\\") ||
		file
			.split("/")
			.some(
				(part) =>
					part === "" ||
					part === "." ||
					part === ".." ||
					part === ".git" ||
					part === PATCH_DIRECTORY,
			)
	) {
		throw new Error(
			"Use a repository-relative text file path without reserved components.",
		);
	}
	const resolved = await realpath(path.join(root, file));
	if (resolved !== path.resolve(root, file))
		throw new Error("Symlink paths are not supported.");
	const relative = path.relative(root, resolved);
	if (
		relative.startsWith(`..${path.sep}`) ||
		relative === ".." ||
		path.isAbsolute(relative)
	) {
		throw new Error("The source file escapes the repository.");
	}
	const info = await stat(resolved);
	if (!info.isFile() || info.size > MAX_FILE_BYTES)
		throw new Error("The source must be a small regular text file.");
	const bytes = await readFile(resolved);
	const text = bytes.toString("utf8");
	if (text.includes("\0") || !Buffer.from(text).equals(bytes))
		throw new Error("The source must be UTF-8 text.");
	return text;
}

/** Create a proposal without source-file or index mutations. */
export async function createDraftPatch(
	cwd: string,
	name: string,
	files: readonly PatchFile[],
): Promise<{ readonly path: string; readonly text: string }> {
	const root = await realpath(
		await gitOutput({ args: ["rev-parse", "--show-toplevel"], cwd }),
	);
	const seen = new Set<string>();
	let patch = "";
	for (const file of files) {
		if (seen.has(file.path))
			throw new Error("Combine edits for each file into one entry.");
		seen.add(file.path);
		const relative = path.relative(root, path.resolve(cwd, file.path));
		const source = await readSource(root, relative);
		patch += fileDiff(relative, source, replaceText(source, file.edits));
	}
	if (patch === "") throw new Error("The proposal contains no changes.");
	const directory = await preparePatchDirectory(root, false);
	const destination = path.join(
		directory,
		`draft-${name}-${randomUUID()}.patch`,
	);
	await writeFileAtomic(destination, patch);
	return { path: destination, text: patch };
}
