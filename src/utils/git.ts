/**
 * Shared git subprocess runner for extensions.
 *
 * Invariants:
 * - Never throws on git failure; failures surface as a non-zero exitCode.
 * - stdout/stderr are buffered as raw bytes and decoded once as UTF-8.
 */

import { spawn } from "node:child_process";

export type GitResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

export async function runGit(
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
	env: Readonly<Record<string, string>> = {},
	input?: string,
): Promise<GitResult> {
	if (signal?.aborted) return { stdout: "", stderr: "aborted", exitCode: 130 };

	return await new Promise<GitResult>((resolve) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const decodeStdout = (): string =>
			Buffer.concat(stdoutChunks).toString("utf8");
		const decodeStderr = (): string =>
			Buffer.concat(stderrChunks).toString("utf8");
		let settled = false;

		const proc = spawn("git", [...args], {
			cwd,
			env: { ...process.env, ...env },
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			signal,
		});

		const settle = (result: GitResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		// Buffer raw bytes and decode once. Per-chunk toString() would split a
		// multibyte UTF-8 sequence straddling a chunk boundary into U+FFFD,
		// corrupting patches fed back into `git apply`.
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});
		proc.on("error", (error) => {
			if ((error as Error).name === "AbortError") {
				settle({ stdout: decodeStdout(), stderr: "aborted", exitCode: 130 });
				return;
			}
			settle({
				stdout: decodeStdout(),
				stderr: `failed to start git: ${error.message}`,
				exitCode: 1,
			});
		});
		proc.on("close", (code) => {
			settle({
				stdout: decodeStdout(),
				stderr: decodeStderr(),
				exitCode: code ?? 0,
			});
		});
		if (input !== undefined) {
			// close/error settle the result; without this listener an EPIPE when git
			// exits before draining stdin would surface as an uncaught exception.
			proc.stdin?.on("error", () => {});
			proc.stdin?.end(input);
		}
	});
}

export function formatGitFailure(command: string, result: GitResult): string {
	const detailParts: string[] = [];
	if (result.stderr) detailParts.push(`stderr:\n${result.stderr}`);
	if (result.stdout) detailParts.push(`stdout:\n${result.stdout}`);
	const details = detailParts.length > 0 ? `\n${detailParts.join("\n\n")}` : "";
	return `git ${command} failed with code ${result.exitCode}.${details}`;
}
