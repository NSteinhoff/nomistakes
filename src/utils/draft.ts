import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { formatGitFailure, gitOutput, runGit } from "./git";
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

async function fileDiff(
	file: string,
	source: string,
	target: string,
): Promise<string> {
	if (target.includes("\0"))
		throw new Error("The proposed text must not contain NUL characters.");
	if (source === target) return "";
	const directory = await mkdtemp(path.join(tmpdir(), "pi-draft-"));
	try {
		const sourcePath = `a/${file}`;
		const targetPath = `b/${file}`;
		for (const filePath of [sourcePath, targetPath]) {
			await mkdir(path.dirname(path.join(directory, filePath)), {
				recursive: true,
			});
		}
		await writeFile(path.join(directory, sourcePath), source);
		await writeFile(path.join(directory, targetPath), target);
		const args = [
			"diff",
			"--no-index",
			"--minimal",
			"--no-prefix",
			"--no-ext-diff",
			"--no-textconv",
			"--no-color",
			"--",
			sourcePath,
			targetPath,
		];
		const result = await runGit({ args, cwd: directory });
		if (result.exitCode !== 0 && result.exitCode !== 1) {
			throw new Error(formatGitFailure(args.join(" "), result));
		}
		return result.stdout;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
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
		patch += await fileDiff(relative, source, replaceText(source, file.edits));
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
