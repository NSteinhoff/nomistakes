import { realpathSync, statSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	EditToolInput,
	ExtensionAPI,
	ExtensionContext,
	FindToolInput,
	GrepToolInput,
	LsToolInput,
	ReadToolInput,
	ToolInfo,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DeleteFileToolInput, MoveFileToolInput } from "./file";
import { pruneSpillDir, SPILL_DIR } from "./utils/spill";

const CHECKED_TOOLS = [
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"move_file",
	"delete_file",
] as const;

const ALLOWED_TOOLS = [
	...CHECKED_TOOLS,
	"ask",
	"make",
	"delegate",
	"status",
	"git_index_track",
	"issues",
	"snapshot",
	"todo",
	"prepare_commit",
] as const;

type CheckedToolName = (typeof CHECKED_TOOLS)[number];
type AllowedToolName = (typeof ALLOWED_TOOLS)[number];

type CheckedToolInputs = {
	ls: LsToolInput;
	write: WriteToolInput;
	read: ReadToolInput;
	edit: EditToolInput;
	grep: GrepToolInput;
	find: FindToolInput;
	move_file: MoveFileToolInput;
	delete_file: DeleteFileToolInput;
};

const READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const BUILTIN_PATH_TOOLS = new Set<CheckedToolName>([
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const agentDir = path.resolve(getAgentDir());

// Bases are matched against canonical paths (see canonicalizePath), so resolve
// each to its realpath; symlinked bases (Homebrew opt/<formula>, stow-managed
// agent dirs) otherwise never match. Missing bases drop out.
const EXTERNAL_READ_ALLOWLIST_BASES = [
	"/opt/homebrew/lib/node_modules/@earendil-works",
	"/opt/homebrew/opt/neovim/share/nvim/runtime",
	path.join(agentDir, "skills"),
	path.join(agentDir, "extensions"),
	path.join(agentDir, "agents"),
	// Read-only recovery of full tool output (see utils/spill.ts). Mutating tools
	// stay blocked here; only the tools themselves write into this directory.
	SPILL_DIR,
]
	.map(resolveRealpath)
	.filter((base): base is string => base !== undefined);

const HIDDEN_PATH_ALLOWLIST_BASES = [
	path.resolve(agentDir, "skills"),
	path.resolve(agentDir, "extensions"),
	path.resolve(agentDir, "agents"),
	"stow/pi/.pi/", // local pi customization source
	".scratch", // temporary files globally ignored by git
];

// Hidden files (relative to cwd) that are explicitly writable without approval,
// but only when cwd is the project root (it directly contains a .git directory).
// This prevents writes from a subdirectory creating a stray .git/PRECHECK_COMMIT_MSG
// outside the repo's real git directory.
const HIDDEN_PATH_ALLOWED_RELATIVE_FILES = [
	path.join(".git", "PRECHECK_COMMIT_MSG"),
];

// Protected file basename prefixes that require confirmation before a mutating
// tool may write/edit/move/delete them, in any directory. Matches e.g.
// "Makefile", "Makefile.agent", "Makefile.something". Reuses the hidden-path
// decision flow.
const PROTECTED_BASENAME_PREFIXES = ["Makefile"];
type HiddenPathDecision = boolean;

type HiddenPathDecisionScope = {
	sessionScope: string;
	cwd: string;
};

// In-memory per-session decisions for hidden-path access prompts.
// Policy decision: approvals are intentionally shared across all tools
// (not tool-scoped) within the same sessionScope+cwd+path key.
// Key: sessionScope|cwd|canonicalPath, Value: true = allow, false = deny.
const hiddenPathDecisions = new Map<string, HiddenPathDecision>();

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		pruneSpillDir();
		setTools(pi);
		if (event.reason !== "startup") {
			listTools(pi, ctx);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;
		if (!isCheckedTool(toolName)) {
			return undefined;
		}

		const paths = getPathInputs(toolName, event.input);
		if (!paths.length) {
			return undefined;
		}

		const canonicalCwd = resolveRealpath(ctx.cwd) ?? path.resolve(ctx.cwd);
		for (const candidate of paths) {
			let resolved: string;
			try {
				resolved = resolveCheckedToolPath(toolName, candidate, ctx.cwd);
			} catch (error) {
				const reason = `Invalid path '${candidate}': ${(error as Error).message}`;
				if (ctx.hasUI) ctx.ui.notify(reason, "warning");
				return { block: true, reason };
			}
			const canonical = await canonicalizePath(resolved);
			const policyPath = canonical ?? resolved;
			const allowedExternalRead = isAllowedExternalReadPath(
				event.toolName,
				policyPath,
			);
			const allowedHiddenPath =
				isAllowedHiddenPath(ctx.cwd, policyPath) ||
				isAllowedHiddenPath(ctx.cwd, resolved);
			const protectedMutation =
				!READONLY_TOOLS.has(event.toolName) &&
				(isProtectedPath(policyPath) || isProtectedPath(resolved));
			const requiresDecision =
				(!allowedHiddenPath && isHiddenPath(policyPath)) || protectedMutation;
			const accessLabel = protectedMutation
				? "protected file"
				: "hidden dotfile";
			let allowedByUserDecision = false;
			if (!isWithinBase(canonicalCwd, policyPath) && !allowedExternalRead) {
				const reason = `Path '${candidate}' resolves outside cwd and is blocked: ${policyPath}`;
				if (ctx.hasUI) {
					ctx.ui.notify(reason, "warning");
				}
				return { block: true, reason };
			}

			if (requiresDecision) {
				const remembered = getHiddenPathDecision(ctx, policyPath);
				if (typeof remembered === "boolean") {
					if (!remembered) {
						const reason = `Blocked ${accessLabel} access (remembered decision): ${candidate}`;
						if (ctx.hasUI) ctx.ui.notify(reason, "warning");
						return { block: true, reason };
					}
					allowedByUserDecision = true;
				} else {
					if (!ctx.hasUI) {
						return {
							block: true,
							reason: `${capitalize(accessLabel)} access requires confirmation, but no UI is available: ${candidate}`,
						};
					}

					const verb = protectedMutation ? "modify" : "access";
					const ok = await ctx.ui.confirm(
						`${capitalize(accessLabel)} access`,
						`Tool '${event.toolName}' wants to ${verb} ${accessLabel} '${candidate}' (${policyPath}). Allow? This decision is remembered for this session.`,
					);
					setHiddenPathDecision(ctx, policyPath, ok);
					if (!ok) {
						const reason = `Blocked ${accessLabel} access: ${candidate}`;
						ctx.ui.notify(reason, "warning");
						return { block: true, reason };
					}
					allowedByUserDecision = true;
				}
			}

			if (allowedByUserDecision && ctx.hasUI) {
				ctx.ui.notify(
					`Allowed ${accessLabel} access by user decision: ${candidate} (${policyPath})`,
					"info",
				);
			}
		}

		return undefined;
	});

	pi.registerCommand("tools", {
		description:
			"List tools, inspect tool prompt payload (/tools <name>), clear hidden-path decisions (/tools --clear)",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart().toLowerCase();
			if (trimmed.includes(" ")) return null;
			const candidates = ["--clear", ...pi.getAllTools().map((t) => t.name)];
			const items = Array.from(new Set(candidates))
				.filter((item) => item.startsWith(trimmed))
				.sort((a, b) => a.localeCompare(b))
				.map((item) => ({ value: item, label: item }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				listTools(pi, ctx);
				return;
			}

			if (command === "--clear") {
				const cleared = hiddenPathDecisions.size;
				hiddenPathDecisions.clear();
				ctx.ui.notify(
					`Cleared ${cleared} remembered hidden-path decision(s).`,
					"info",
				);
				return;
			}

			inspectTool(pi, ctx, command);
		},
	});

	pi.registerCommand("system-prompt", {
		description: "Print the active system prompt",
		handler: async (_args, ctx) => {
			const systemPrompt = ctx.getSystemPrompt();
			ctx.ui.notify(systemPrompt || "(empty system prompt)", "info");
		},
	});
}

function inspectTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	nameInput: string,
) {
	const name = nameInput.trim();
	const allTools = pi.getAllTools();
	const tool = allTools.find((candidate) => candidate.name === name);
	if (!tool) {
		ctx.ui.notify(`Unknown tool '${name}'.`, "warning");
		return;
	}

	const activeSet = new Set(pi.getActiveTools());
	ctx.ui.notify(formatToolInspection(tool, activeSet.has(tool.name)), "info");
}

function formatToolInspection(tool: ToolInfo, isActive: boolean): string {
	const lines: string[] = [];
	lines.push(`Tool: ${tool.name}`);
	lines.push(`Active: ${isActive ? "yes" : "no"}`);
	lines.push("Description:");
	lines.push(tool.description || "(none)");
	lines.push("Parameters:");
	lines.push(JSON.stringify(tool.parameters ?? {}, null, 2));
	return lines.join("\n");
}

function listTools(pi: ExtensionAPI, ctx: ExtensionContext) {
	const blocks: string[] = [`Agent Dir: ${getAgentDir()}`];
	blocks.push(formatToolsBlock(pi));
	blocks.push(formatApprovedHiddenPathsBlock());
	blocks.push(formatExternalReadAllowlistBlock());
	blocks.push(formatHiddenPathAllowlistBlock());
	blocks.push(formatProtectedFilesBlock());
	ctx.ui.notify(blocks.join("\n\n"), "info");
}

function formatToolsBlock(pi: ExtensionAPI): string {
	const lines = ["Tools:"];
	for (const tool of pi.getActiveTools()) {
		lines.push(`- ${tool}`);
	}
	return lines.join("\n");
}

function formatApprovedHiddenPathsBlock(): string {
	const approvedHiddenPaths = Array.from(hiddenPathDecisions.entries())
		.filter(([, allowed]) => allowed)
		.map(([key]) => splitHiddenPathDecisionKey(key).policyPath)
		.sort((a, b) => a.localeCompare(b));

	const lines = ["Approved hidden paths:"];
	if (approvedHiddenPaths.length === 0) {
		lines.push("- none");
	} else {
		for (const resolved of approvedHiddenPaths) {
			lines.push(`- ${resolved}`);
		}
	}

	return lines.join("\n");
}

function formatExternalReadAllowlistBlock(): string {
	const lines = ["External read allowlist:"];
	for (const base of EXTERNAL_READ_ALLOWLIST_BASES) {
		lines.push(`- ${base}`);
	}
	return lines.join("\n");
}

function formatHiddenPathAllowlistBlock(): string {
	const lines = ["Hidden path allowlist:"];
	for (const base of HIDDEN_PATH_ALLOWLIST_BASES) {
		lines.push(`- ${base}`);
	}
	for (const relativeFile of HIDDEN_PATH_ALLOWED_RELATIVE_FILES) {
		lines.push(`- <cwd>/${relativeFile} (file, project root only)`);
	}
	return lines.join("\n");
}

function formatProtectedFilesBlock(): string {
	const lines = ["Protected files (mutation requires confirmation):"];
	for (const prefix of PROTECTED_BASENAME_PREFIXES) {
		lines.push(`- **/${prefix}* (any directory)`);
	}
	return lines.join("\n");
}

function setTools(pi: ExtensionAPI) {
	const allowedTools = pi
		.getAllTools()
		.map((tool) => tool.name)
		.filter(isAllowedTool);
	pi.setActiveTools(allowedTools);
}

function isAllowedTool(toolName: string): toolName is AllowedToolName {
	return ALLOWED_TOOLS.includes(toolName as AllowedToolName);
}
function isCheckedTool(toolName: string): toolName is CheckedToolName {
	return CHECKED_TOOLS.includes(toolName as CheckedToolName);
}

function getHiddenPathDecisionScope(
	ctx: ExtensionContext,
): HiddenPathDecisionScope {
	const sessionScope =
		typeof ctx.sessionManager?.getSessionFile === "function"
			? (ctx.sessionManager.getSessionFile() ?? "no-session")
			: "no-session";
	return {
		sessionScope,
		cwd: ctx.cwd,
	};
}

function buildHiddenPathDecisionKey(
	scope: HiddenPathDecisionScope,
	policyPath: string,
): string {
	return `${scope.sessionScope}|${scope.cwd}|${policyPath}`;
}

function splitHiddenPathDecisionKey(key: string): {
	scope: string;
	policyPath: string;
} {
	const lastSep = key.lastIndexOf("|");
	if (lastSep < 0) {
		return { scope: "", policyPath: key };
	}
	return {
		scope: key.slice(0, lastSep),
		policyPath: key.slice(lastSep + 1),
	};
}

function getHiddenPathDecision(
	ctx: ExtensionContext,
	policyPath: string,
): HiddenPathDecision | undefined {
	const scope = getHiddenPathDecisionScope(ctx);
	const key = buildHiddenPathDecisionKey(scope, policyPath);
	return hiddenPathDecisions.get(key);
}

function setHiddenPathDecision(
	ctx: ExtensionContext,
	policyPath: string,
	decision: HiddenPathDecision,
): void {
	const scope = getHiddenPathDecisionScope(ctx);
	const key = buildHiddenPathDecisionKey(scope, policyPath);
	hiddenPathDecisions.set(key, decision);
}

function isWithinBase(baseDir: string, candidatePath: string): boolean {
	const relative = path.relative(baseDir, candidatePath);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function isAllowedExternalReadPath(
	toolName: string,
	candidatePath: string,
): boolean {
	if (!READONLY_TOOLS.has(toolName)) return false;
	return EXTERNAL_READ_ALLOWLIST_BASES.some((base) =>
		isWithinBase(base, candidatePath),
	);
}

function isAllowedHiddenPath(cwd: string, candidatePath: string): boolean {
	const withinBase = HIDDEN_PATH_ALLOWLIST_BASES.some((base) =>
		isWithinBase(base, candidatePath),
	);
	if (withinBase) return true;
	if (!isProjectRoot(cwd)) return false;
	return HIDDEN_PATH_ALLOWED_RELATIVE_FILES.some(
		(relativeFile) =>
			path.relative(path.resolve(cwd, relativeFile), candidatePath) === "",
	);
}

// The project root is the directory that directly contains a .git directory.
function isProjectRoot(cwd: string): boolean {
	try {
		return statSync(path.join(cwd, ".git")).isDirectory();
	} catch {
		return false;
	}
}

function isProtectedPath(candidatePath: string): boolean {
	const basename = path.basename(candidatePath);
	return PROTECTED_BASENAME_PREFIXES.some((prefix) =>
		basename.startsWith(prefix),
	);
}

function capitalize(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function isHiddenPath(candidatePath: string): boolean {
	const parts = candidatePath.split(path.sep).filter((part) => part.length > 0);
	for (const part of parts) {
		if (part === "." || part === "..") continue;
		if (part.startsWith(".")) return true;
	}
	return false;
}

function resolveRealpath(candidatePath: string): string | undefined {
	try {
		return realpathSync(candidatePath);
	} catch {
		return undefined;
	}
}

async function canonicalizePath(
	candidatePath: string,
): Promise<string | undefined> {
	let current = candidatePath;
	const suffixParts: string[] = [];

	while (true) {
		try {
			const stats = await lstat(current);
			if (stats.isSymbolicLink()) {
				const resolved = await realpath(current);
				return path.join(resolved, ...suffixParts.reverse());
			}
			const resolved = await realpath(current);
			return path.join(resolved, ...suffixParts.reverse());
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") return undefined;
		}

		const parent = path.dirname(current);
		if (parent === current) return undefined;
		suffixParts.push(path.basename(current));
		current = parent;
	}
}

function getPathInputs(toolName: CheckedToolName, input: unknown): string[] {
	const paths: string[] = [];

	switch (toolName) {
		case "grep":
		case "ls":
		case "find":
		case "edit":
		case "write":
		case "read": {
			const toolInput = input as CheckedToolInputs[typeof toolName];
			paths.push(safeString(toolInput.path));
			break;
		}

		case "move_file": {
			const toolInput = input as CheckedToolInputs[typeof toolName];
			paths.push(safeTrimmedString(toolInput.path));
			paths.push(safeTrimmedString(toolInput.destination));
			break;
		}

		case "delete_file": {
			const toolInput = input as CheckedToolInputs[typeof toolName];
			paths.push(safeTrimmedString(toolInput.path));
			break;
		}

		default: {
			const _name: never = toolName;
			break;
		}
	}

	return paths.filter((candidate) => candidate !== "");
}

function resolveCheckedToolPath(
	toolName: CheckedToolName,
	candidate: string,
	cwd: string,
): string {
	if (!BUILTIN_PATH_TOOLS.has(toolName)) {
		return path.resolve(cwd, candidate);
	}

	let normalized = candidate.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") {
		normalized = homedir();
	} else if (
		normalized.startsWith("~/") ||
		(process.platform === "win32" && normalized.startsWith("~\\"))
	) {
		normalized = path.join(homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
	return path.resolve(cwd, normalized);
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function safeTrimmedString(value: unknown): string {
	return safeString(value).trim();
}
