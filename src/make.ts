/**
 * Runs documented Makefile targets from the worktree root.
 *
 * Invariants:
 * - Makefile.agent wins over Makefile.
 * - Missing `help` targets fall back to parsed target docs.
 * - Aborts terminate the process group when supported.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	buildExpandableMiddleOutput,
	buildExpandableTailOutput,
	type ExpandableOutputDetails,
	formatThemedExpandableOutput,
} from "./utils/tool-output";

type TargetInfo = {
	name: string;
	description?: string;
};

type ToolDetails = ExpandableOutputDetails;

type MakeProcessOutput = {
	readonly stdout: string;
	readonly stderr: string;
};

type MakeProcessOutcome = MakeProcessOutput &
	(
		| { readonly status: "success" }
		| {
				readonly status: "failed";
				readonly exitCode: number | null;
				readonly signal: NodeJS.Signals | null;
		  }
		| { readonly status: "timed-out"; readonly timeoutMs: number }
		| { readonly status: "aborted" }
		| { readonly status: "start-failed"; readonly errorMessage: string }
	);

const MAKE_TIMEOUT_SECONDS = 2 * 60;
const MAKE_TIMEOUT_MS = MAKE_TIMEOUT_SECONDS * 1000;
const PROCESS_KILL_GRACE_MS = 1000;

const DESCRIPTION = [
	"Run Makefile targets from the worktree root for build/test/check/fmt/lint/verify workflows.",
	"Run target='help' first to discover targets. Prefer this over ad hoc shell commands.",
];

const parameters = Type.Object({
	target: Type.Optional(
		Type.String({
			description:
				"Make target (for example help, check, test). Omit for default. Use help first.",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 30 * 60,
			description: `Per-run timeout in seconds (default: ${MAKE_TIMEOUT_SECONDS}). Use shorter timeouts when you diagnose known hangs.`,
		}),
	),
	forceRebuild: Type.Optional(
		Type.Boolean({
			description:
				"Unconditionally rebuild all targets, ignoring timestamps. Default: false.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof parameters, ToolDetails>({
		name: "make",
		label: "Make",
		description: DESCRIPTION.join(" "),
		parameters,
		// Spawns build/test/fix subprocesses that mutate the worktree and may
		// hold tool locks; concurrent target runs would conflict.
		executionMode: "sequential",

		renderCall(args, theme) {
			const target = args.target?.trim();
			const timeout = args.timeoutSeconds
				? ` timeout ${formatDuration(secondsToMilliseconds(args.timeoutSeconds))}`
				: "";
			const forceRebuild = args.forceRebuild ? " force-rebuild" : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("make ")) +
					theme.fg("accent", target || "(default target)") +
					theme.fg("muted", timeout + forceRebuild),
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			const fallbackText = result.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n");
			return new Text(
				formatThemedExpandableOutput(
					result.details ?? {},
					options.expanded,
					theme,
					24,
					{
						edge: "tail",
						fallbackText,
					},
				),
				0,
				0,
			);
		},

		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			return await execute(params, ctx, signal);
		},
	});
}

const execute = async (
	params: Static<typeof parameters>,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<ToolDetails>> => {
	const worktree = ctx.cwd;
	const target = params.target?.trim();
	const timeoutMs = params.timeoutSeconds
		? secondsToMilliseconds(params.timeoutSeconds)
		: MAKE_TIMEOUT_MS;
	const wantsHelp = target === "help";
	const makefile = await getMakefileTargets(worktree);

	if (!makefile || makefile.targets.length === 0) {
		throw boundedMakeError("No Makefile targets!");
	}

	const targetAvailableOrDefault = target
		? wantsHelp || makefile.targets.some((t) => t.name === target)
		: true;

	if (wantsHelp || !targetAvailableOrDefault) {
		const hasHelpTarget = makefile.targets.some((item) => item.name === "help");
		const helpText = hasHelpTarget
			? requireMakeSuccess(
					await runMake(makefile.path, "help", worktree, timeoutMs, signal),
				)
			: formatHelp(makefile.targets);

		if (!targetAvailableOrDefault) {
			throw boundedMakeError(
				`Error: Target '${target}' not available!\n\n${helpText}`,
			);
		}

		return textResult(helpText);
	}

	const outcome = await runMake(
		makefile.path,
		target,
		worktree,
		timeoutMs,
		signal,
		params.forceRebuild ?? false,
	);
	const text = requireMakeSuccess(outcome);

	return textResult(text);
};

async function runMake(
	path: string,
	target: string | undefined,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
	forceRebuild = false,
): Promise<MakeProcessOutcome> {
	if (signal?.aborted) {
		return { status: "aborted", stdout: "", stderr: "" };
	}

	return await new Promise<MakeProcessOutcome>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let abortReason: "signal" | "timeout" | undefined;
		let killEscalationTimeout: ReturnType<typeof setTimeout> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const args = ["-f", path];
		if (forceRebuild) {
			args.push("-B");
		}
		if (target) {
			args.push(target);
		}

		const proc = spawn("make", args, {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		const processOutput = (): MakeProcessOutput => ({ stdout, stderr });
		const settle = (outcome: MakeProcessOutcome): void => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (killEscalationTimeout) clearTimeout(killEscalationTimeout);
			signal?.removeEventListener("abort", onAbort);
			resolve(outcome);
		};
		const requestAbort = (reason: "signal" | "timeout"): void => {
			if (abortReason) return;
			abortReason = reason;
			killEscalationTimeout = terminateProcess(proc);
		};
		const onAbort = (): void => {
			requestAbort("signal");
		};

		proc.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
		});
		proc.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		proc.on("error", (error) => {
			settle({
				status: "start-failed",
				errorMessage: error.message,
				...processOutput(),
			});
		});
		proc.on("close", (code, closeSignal) => {
			if (abortReason === "timeout") {
				settle({ status: "timed-out", timeoutMs, ...processOutput() });
				return;
			}

			if (abortReason === "signal") {
				settle({ status: "aborted", ...processOutput() });
				return;
			}

			if (code !== 0) {
				settle({
					status: "failed",
					exitCode: code,
					signal: closeSignal,
					...processOutput(),
				});
				return;
			}

			settle({ status: "success", ...processOutput() });
		});

		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			requestAbort("signal");
		}
		timeout = setTimeout(() => {
			requestAbort("timeout");
		}, timeoutMs);
	});
}

function terminateProcess(
	proc: ChildProcess,
): ReturnType<typeof setTimeout> | undefined {
	const pid = proc.pid;
	if (!pid) return undefined;

	killProcessOrGroup(pid, "SIGTERM");
	return setTimeout(() => {
		killProcessOrGroup(pid, "SIGKILL");
	}, PROCESS_KILL_GRACE_MS);
}

function killProcessOrGroup(pid: number, signal: NodeJS.Signals): void {
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
			return;
		} catch (error: unknown) {
			if (isMissingProcessError(error)) return;
		}
	}

	try {
		process.kill(pid, signal);
	} catch (error: unknown) {
		if (!isMissingProcessError(error)) return;
	}
}

function isMissingProcessError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ESRCH"
	);
}

function requireMakeSuccess(outcome: MakeProcessOutcome): string {
	const text = formatMakeOutcome(outcome);
	if (outcome.status !== "success") {
		throw boundedMakeError(text);
	}
	return text;
}

function formatMakeOutcome(outcome: MakeProcessOutcome): string {
	const combined = [outcome.stdout, outcome.stderr]
		.filter(Boolean)
		.join("\n")
		.trim();
	const output = combined || "(no output)";

	switch (outcome.status) {
		case "success":
			return combined || "Success! make completed with no output.";
		case "failed": {
			const reason =
				outcome.exitCode !== null
					? `make exited with code ${outcome.exitCode}`
					: outcome.signal
						? `make terminated by ${outcome.signal}`
						: "make exited with unknown status";
			return `${reason}:\n${output}`;
		}
		case "timed-out":
			return `make timed out after ${formatDuration(outcome.timeoutMs)}:\n${output}`;
		case "aborted":
			return `make aborted:\n${output}`;
		case "start-failed":
			return combined
				? `failed to start make: ${outcome.errorMessage}\n${combined}`
				: `failed to start make: ${outcome.errorMessage}`;
	}
}

function boundedMakeError(text: string): Error {
	let output = buildExpandableMiddleOutput(text);
	const exceedsLimits =
		Buffer.byteLength(text, "utf8") > DEFAULT_MAX_BYTES ||
		(text.length > 0 && text.split("\n").length > DEFAULT_MAX_LINES);

	// Middle truncation cannot split an oversized single line. Fall back to the
	// bounded tail strategy rather than passing that line through unchanged.
	if (exceedsLimits && !output.details.contentTruncation.truncated) {
		output = buildExpandableTailOutput(text);
	}
	return new Error(output.contentText);
}

function secondsToMilliseconds(seconds: number): number {
	return seconds * 1000;
}

function formatDuration(milliseconds: number): string {
	const seconds = milliseconds / 1000;
	if (Number.isInteger(seconds) && seconds < 60) {
		return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
	}

	const minutes = seconds / 60;
	if (Number.isInteger(minutes)) {
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
	}

	return `${milliseconds} ms`;
}

async function getMakefileTargets(
	worktree: string,
): Promise<{ path: string; targets: TargetInfo[] } | undefined> {
	const makefile =
		(await getMakefileContents(worktree, "Makefile.agent")) ||
		(await getMakefileContents(worktree, "Makefile"));

	if (!makefile) {
		return undefined;
	}

	return {
		path: makefile.path,
		targets: parseTargets(makefile.contents).filter(
			(target) => !!target.description,
		),
	};
}

function formatHelp(targets: TargetInfo[]): string {
	if (targets.length === 0) {
		return "No documented make targets found in Makefile.";
	}

	const lines = ["Available make targets:"];
	for (const target of targets) {
		lines.push(`- ${target.name}: ${target.description}`);
	}

	return lines.join("\n");
}

function parseTargets(makefileContent: string): TargetInfo[] {
	const lines = makefileContent.split(/\r?\n/);
	const targets: TargetInfo[] = [];
	const seen = new Set<string>();
	let pendingDocLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.startsWith("##")) {
			const doc = trimmed.replace(/^##\s?/, "").trim();
			if (doc.length > 0) pendingDocLines.push(doc);
			continue;
		}

		const match =
			line.match(/^([A-Za-z0-9_./-][A-Za-z0-9_./-]*)\s*:(?![=])(.*)$/) ?? [];
		if (match?.[1]) {
			const name = match[1];
			const rest = match[2] ?? "";

			pendingDocLines = pendingDocLines.filter((item) => item.length > 0);

			if (name.startsWith(".") || name.includes("%") || seen.has(name)) {
				pendingDocLines = [];
				continue;
			}

			const inlineDocMatch = rest.match(/\s##\s*(.+)$/);
			const inlineDoc = inlineDocMatch?.[1]?.trim();
			const description = inlineDoc || pendingDocLines.join(" ") || undefined;

			targets.push({ name, description });
			seen.add(name);
			pendingDocLines = [];
			continue;
		}

		if (
			trimmed.length === 0 ||
			trimmed.startsWith("#") ||
			line.startsWith("\t")
		) {
			continue;
		}

		pendingDocLines = [];
	}

	return targets;
}

async function getMakefileContents(
	worktree: string,
	filename: string,
): Promise<{ path: string; contents: string } | undefined> {
	const makefilePath = path.join(worktree, filename);
	try {
		await access(makefilePath);
		const contents = await readFile(makefilePath, "utf8");
		return { path: makefilePath, contents };
	} catch {
		return undefined;
	}
}

function textResult(text: string): AgentToolResult<ToolDetails> {
	const { contentText, details } = buildExpandableMiddleOutput(text);
	return {
		content: [{ type: "text", text: contentText }],
		details,
	};
}
