import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";

/** Return null only for an absent path. Preserve symlinks and inspection errors. */
export async function lstatOrNull(file: string): Promise<Stats | null> {
	try {
		return await lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}
