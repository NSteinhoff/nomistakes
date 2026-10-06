/**
 * Shared git subprocess runner for extensions.
 *
 * Invariants:
 * - Never throws on git failure; failures surface as a non-zero exitCode.
 * - Raw stdout remains available for byte-exact patch exports.
 */

import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type GitResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

type GitBytesResult = Omit<GitResult, "stdout"> & { readonly stdout: Buffer };

type GitParams = {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly signal?: AbortSignal | undefined;
	readonly env?: Readonly<Record<string, string>> | undefined;
	readonly input?: string | Buffer | undefined;
};

export async function runGit(params: GitParams): Promise<GitResult> {
	const result = await runGitBytes(params);
	return { ...result, stdout: result.stdout.toString("utf8") };
}

export async function runGitBytes({
	args,
	cwd,
	env = {},
	input,
	signal,
}: GitParams): Promise<GitBytesResult> {
	if (signal?.aborted)
		return { stdout: Buffer.alloc(0), stderr: "aborted", exitCode: 130 };

	return await new Promise<GitBytesResult>((resolve) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const collectStdout = (): Buffer => Buffer.concat(stdoutChunks);
		const decodeStderr = (): string =>
			Buffer.concat(stderrChunks).toString("utf8");
		let settled = false;

		const proc = spawn("git", [...args], {
			cwd,
			env: { ...process.env, ...env },
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			signal,
		});

		const settle = (result: GitBytesResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		// Patch bytes can contain non-UTF-8 content. Preserve them without text conversion.
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});
		proc.on("error", (error) => {
			if ((error as Error).name === "AbortError") {
				settle({ stdout: collectStdout(), stderr: "aborted", exitCode: 130 });
				return;
			}
			settle({
				stdout: collectStdout(),
				stderr: `failed to start git: ${error.message}`,
				exitCode: 1,
			});
		});
		proc.on("close", (code, terminationSignal) => {
			const stderr = decodeStderr();
			settle({
				stdout: collectStdout(),
				stderr: terminationSignal
					? [stderr, `git terminated by signal ${terminationSignal}`]
							.filter(Boolean)
							.join("\n")
					: stderr,
				exitCode: code ?? 1,
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

export async function gitOutput(params: GitParams): Promise<string> {
	const result = await runGit(params);
	if (result.exitCode !== 0) {
		throw new Error(formatGitFailure(params.args.join(" "), result));
	}
	return result.stdout.trim();
}

export function formatGitFailure(command: string, result: GitResult): string {
	const detailParts: string[] = [];
	if (result.stderr) detailParts.push(`stderr:\n${result.stderr}`);
	if (result.stdout) detailParts.push(`stdout:\n${result.stdout}`);
	const details = detailParts.length > 0 ? `\n${detailParts.join("\n\n")}` : "";
	return `git ${command} failed with code ${result.exitCode}.${details}`;
}

export async function gitAddExcludeRule(
	rule: string,
	cwd: string,
): Promise<void> {
	const excludeFilePath = path.resolve(
		cwd,
		await gitOutput({
			args: ["rev-parse", "--git-path", "info/exclude"],
			cwd,
		}),
	);
	await mkdir(path.dirname(excludeFilePath), { recursive: true });

	let text = "";
	try {
		text = await readFile(excludeFilePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}

	if (!splitLines(text).includes(rule)) {
		await appendFile(excludeFilePath, `\n${rule}\n`);
	}

	const check = rule.startsWith("/") ? rule.slice(1) : rule;
	const ignored = await runGit({
		args: ["check-ignore", "--quiet", "--", check],
		cwd,
	});

	if (ignored.exitCode !== 0) {
		throw new Error(
			"Git does not ignore the patch directory. Check the parent checkout's ignore rules.",
		);
	}
}

function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}
