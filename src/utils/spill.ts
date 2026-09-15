/**
 * Spills complete tool output to a temp file so the agent can recover it in
 * full (via `read`) when the in-context view is truncated.
 *
 * Invariants:
 * - Files live under a single tmpdir subtree (SPILL_DIR) so the path-guard can
 *   grant a narrow read-only exception for it.
 * - Best-effort: every failure degrades to "no spill", never throws.
 */

import {
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SPILL_DIR = path.join(tmpdir(), "pi-agent-spill");

// Created eagerly at module load: the path-guard allowlist realpath-resolves
// its bases at load and drops missing ones, so SPILL_DIR must exist before that
// array is built for the read exception to take effect.
try {
	mkdirSync(SPILL_DIR, { recursive: true });
} catch {
	// Best-effort; spill is a non-critical recovery aid.
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Drops spill files older than MAX_AGE_MS. The OS reclaims tmpdir on reboot;
// this bounds growth within a long-lived session host between reboots.
export function pruneSpillDir(): void {
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

// Writes the complete output and returns the path, or undefined on failure.
export function writeSpillFile(text: string): string | undefined {
	try {
		const name = `spill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`;
		const file = path.join(SPILL_DIR, name);
		writeFileSync(file, text, "utf8");
		return file;
	} catch {
		return undefined;
	}
}
