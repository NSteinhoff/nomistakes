/** Preserves complete tool output for recovery through a narrow read exception. */

import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Initialize before the path policy resolves its read exception.
export const SPILL_DIR = prepareSpillDir(path.join(getAgentDir(), "spill"));

function prepareSpillDir(directory: string): string | undefined {
	let descriptor: number | undefined;
	try {
		const uid = process.getuid?.();
		if (uid === undefined) return undefined;
		mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
		descriptor = openSync(
			directory,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		const stats = fstatSync(descriptor);
		if (!stats.isDirectory() || stats.uid !== uid) return undefined;
		// Use the descriptor so permission changes cannot follow a replaced symlink.
		fchmodSync(descriptor, DIRECTORY_MODE);
		if ((fstatSync(descriptor).mode & 0o777) !== DIRECTORY_MODE)
			return undefined;
		return realpathSync(directory);
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Spill recovery remains optional when descriptor cleanup fails.
			}
		}
	}
}

// Bound disk use without invalidation at session shutdown.
export function pruneSpillDir(): void {
	if (!SPILL_DIR || prepareSpillDir(SPILL_DIR) !== SPILL_DIR) return;
	let entries: string[];
	try {
		entries = readdirSync(SPILL_DIR);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of entries) {
		const file = path.join(SPILL_DIR, name);
		try {
			if (now - statSync(file).mtimeMs > MAX_AGE_MS) {
				rmSync(file, { force: true });
			}
		} catch {
			// Ignore unreadable/locked entries.
		}
	}
}

export function writeSpillFile(text: string): string | undefined {
	if (!SPILL_DIR || prepareSpillDir(SPILL_DIR) !== SPILL_DIR) return undefined;
	try {
		const name = `spill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`;
		const file = path.join(SPILL_DIR, name);
		writeFileSync(file, text, {
			encoding: "utf8",
			flag: "wx",
			mode: FILE_MODE,
		});
		return file;
	} catch {
		return undefined;
	}
}
