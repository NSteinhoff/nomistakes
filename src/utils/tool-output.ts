import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type Theme,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { writeSpillFile } from "./spill";

export type ExpandableOutputDetails = {
	fullText: string;
	fullTextTruncated: boolean;
	contentTruncation: TruncationResult;
	renderTruncation: TruncationResult;
	// Path to the complete output on disk, present only when truncated.
	spillPath?: string;
};

const FULL_TEXT_MAX_LINES = DEFAULT_MAX_LINES * 10;
const FULL_TEXT_MAX_BYTES = DEFAULT_MAX_BYTES * 10;

// Share of the budget given to the head when truncating the middle; the tail
// keeps the rest. Biased toward the tail, where build/test failures summarize,
// while still preserving the first errors at the head.
const MIDDLE_HEAD_FRACTION = 0.2;

export function buildExpandableOutput(text: string): {
	contentText: string;
	details: ExpandableOutputDetails;
} {
	return buildExpandableOutputWithTruncator(text, truncateHead);
}

export function buildExpandableTailOutput(text: string): {
	contentText: string;
	details: ExpandableOutputDetails;
} {
	return buildExpandableOutputWithTruncator(text, truncateTail);
}

// Keeps the head and the tail, eliding the middle with an inline notice. Suits
// build/test output where the first errors and the final summary both matter
// but the bulk in between is noise.
export function buildExpandableMiddleOutput(text: string): {
	contentText: string;
	details: ExpandableOutputDetails;
} {
	const contentTruncation = truncateMiddle(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	const renderTruncation = truncateMiddle(text, {
		maxLines: FULL_TEXT_MAX_LINES,
		maxBytes: FULL_TEXT_MAX_BYTES,
	});
	const spillPath = contentTruncation.truncated
		? writeSpillFile(text)
		: undefined;
	return {
		contentText: withSpillNotice(
			normalizeOutputText(contentTruncation.content),
			spillPath,
		),
		details: {
			fullText: renderTruncation.content,
			fullTextTruncated: renderTruncation.truncated,
			contentTruncation,
			// The elision notice lives inside the content, so suppress the edge-based
			// render notice to avoid a duplicate.
			renderTruncation: { ...renderTruncation, truncated: false },
			spillPath,
		},
	};
}

function truncateMiddle(
	text: string,
	options: { maxLines: number; maxBytes: number },
): TruncationResult {
	const { maxLines, maxBytes } = options;
	const totalLines = text.length === 0 ? 0 : text.split("\n").length;
	const totalBytes = Buffer.byteLength(text, "utf-8");
	const result = (
		content: string,
		truncated: boolean,
		truncatedBy: "lines" | "bytes" | null,
	): TruncationResult => ({
		content,
		truncated,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: content.length === 0 ? 0 : content.split("\n").length,
		outputBytes: Buffer.byteLength(content, "utf-8"),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	});

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return result(text, false, null);
	}

	const headLineBudget = Math.max(
		1,
		Math.floor(maxLines * MIDDLE_HEAD_FRACTION),
	);
	const headByteBudget = Math.max(
		1,
		Math.floor(maxBytes * MIDDLE_HEAD_FRACTION),
	);
	const head = truncateHead(text, {
		maxLines: headLineBudget,
		maxBytes: headByteBudget,
	});
	const tail = truncateTail(text, {
		maxLines: maxLines - headLineBudget,
		maxBytes: maxBytes - headByteBudget,
	});

	const hiddenLines = totalLines - head.outputLines - tail.outputLines;
	if (hiddenLines <= 0) {
		// Head and tail slices already span the whole input; nothing to elide.
		return result(text, false, null);
	}

	const headContent = head.content.replace(/\n+$/g, "");
	const tailContent = tail.content.replace(/^\n+/g, "");
	const notice = `... (${hiddenLines} lines hidden; first ${head.outputLines} and last ${tail.outputLines} of ${totalLines} shown)`;
	return result(
		`${headContent}\n${notice}\n${tailContent}`,
		true,
		totalBytes > maxBytes ? "bytes" : "lines",
	);
}

function buildExpandableOutputWithTruncator(
	text: string,
	truncate: typeof truncateHead,
): {
	contentText: string;
	details: ExpandableOutputDetails;
} {
	const contentTruncation = truncate(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	const renderTruncation = truncate(text, {
		maxLines: FULL_TEXT_MAX_LINES,
		maxBytes: FULL_TEXT_MAX_BYTES,
	});
	const spillPath = contentTruncation.truncated
		? writeSpillFile(text)
		: undefined;
	return {
		contentText: formatTruncatedOutputText(
			contentTruncation.content,
			contentTruncation,
			truncate === truncateHead ? "head" : "tail",
			spillPath,
		),
		details: {
			fullText: renderTruncation.content,
			fullTextTruncated: renderTruncation.truncated,
			contentTruncation,
			renderTruncation,
			spillPath,
		},
	};
}

function formatTruncatedOutputText(
	text: string,
	truncation: TruncationResult,
	edge: "head" | "tail",
	spillPath?: string,
): string {
	const normalized = normalizeOutputText(text);
	if (!truncation.truncated) return normalized;
	const notice = withSpillNotice(formatTruncationNotice(truncation), spillPath);
	if (!normalized) return notice;
	return edge === "head"
		? `${normalized}\n${notice}`
		: `${notice}\n${normalized}`;
}

// Appends a recovery pointer to the complete output. The agent can `read` this
// path (paginated) to retrieve anything the truncated view omitted.
function withSpillNotice(text: string, spillPath: string | undefined): string {
	if (!spillPath) return text;
	return `${text}\n... (full output: ${spillPath})`;
}

function formatTruncationNotice(truncation: TruncationResult): string {
	return `... (${describeTruncation(truncation)})`;
}

function describeTruncation(truncation: TruncationResult): string {
	if (truncation.firstLineExceedsLimit) {
		return `output omitted: first line exceeds ${formatByteCount(truncation.maxBytes)} byte limit`;
	}
	if (truncation.truncatedBy === "bytes") {
		return `output truncated by bytes: showing ${formatByteCount(truncation.outputBytes)} of ${formatByteCount(truncation.totalBytes)}`;
	}
	if (truncation.truncatedBy === "lines") {
		return `output truncated by lines: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	}
	return "output truncated";
}

function formatByteCount(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatExpandableOutputText(
	text: string,
	renderTruncation: TruncationResult | undefined,
	expanded: boolean,
	maxLines: number,
): string {
	return formatExpandableOutputTextFromEdge(
		text,
		renderTruncation,
		expanded,
		maxLines,
		"head",
	);
}

export function formatExpandableTailOutputText(
	text: string,
	renderTruncation: TruncationResult | undefined,
	expanded: boolean,
	maxLines: number,
): string {
	return formatExpandableOutputTextFromEdge(
		text,
		renderTruncation,
		expanded,
		maxLines,
		"tail",
	);
}

type ExpandableRenderEdge = "head" | "tail";

type ThemedExpandableOutputDetails = {
	readonly fullText?: string;
	readonly renderTruncation?: TruncationResult;
};

export function formatThemedExpandableOutput(
	details: ThemedExpandableOutputDetails,
	expanded: boolean,
	theme: Theme,
	maxLines: number,
	options: {
		readonly edge?: ExpandableRenderEdge;
		readonly fallbackText?: string;
	} = {},
): string {
	const edge = options.edge ?? "head";
	const fallbackText = options.fallbackText ?? "(no output)";
	const text = details.fullText || fallbackText;
	const formatted =
		edge === "head"
			? formatExpandableOutputText(
					text,
					details.renderTruncation,
					expanded,
					maxLines,
				)
			: formatExpandableTailOutputText(
					text,
					details.renderTruncation,
					expanded,
					maxLines,
				);
	return formatTruncationHintWithTheme(formatted, edge, theme);
}

function formatTruncationHintWithTheme(
	text: string,
	edge: ExpandableRenderEdge,
	theme: Theme,
): string {
	const lines = text.split("\n");
	const hintIndex = edge === "head" ? lines.length - 1 : 0;
	const hint = lines[hintIndex];
	if (!hint?.startsWith("... (")) return theme.fg("toolOutput", text);

	lines[hintIndex] = theme.fg("muted", hint);
	return lines
		.map((line, index) =>
			index === hintIndex ? line : theme.fg("toolOutput", line),
		)
		.join("\n");
}

function formatExpandableOutputTextFromEdge(
	text: string,
	renderTruncation: TruncationResult | undefined,
	expanded: boolean,
	maxLines: number,
	edge: "head" | "tail",
): string {
	const normalized = normalizeOutputText(text);
	const lines = normalized ? normalized.split("\n") : [];
	const renderNotice = renderTruncation?.truncated
		? formatTruncationNotice(renderTruncation)
		: undefined;
	if (expanded || lines.length <= maxLines) {
		if (!renderNotice) return normalized;
		if (!normalized) return renderNotice;
		return edge === "head"
			? `${normalized}\n${renderNotice}`
			: `${renderNotice}\n${normalized}`;
	}
	const shown =
		edge === "head"
			? lines.slice(0, maxLines).join("\n")
			: lines.slice(-maxLines).join("\n");
	const visibleLines = lines.length;
	const hiddenFromPreviewWithinShown = Math.max(0, visibleLines - maxLines);
	const hiddenFromTruncationTail = renderTruncation?.truncated
		? Math.max(0, renderTruncation.totalLines - visibleLines)
		: 0;
	const hidden = hiddenFromPreviewWithinShown + hiddenFromTruncationTail;
	const hiddenSuffix =
		hidden > 0
			? edge === "head"
				? `${hidden} more lines`
				: `${hidden} earlier lines`
			: "more output";
	const suffixParts = [hiddenSuffix];
	if (renderTruncation?.truncated) {
		suffixParts.push(describeTruncation(renderTruncation));
	}
	const hint = `... (${suffixParts.join("; ")}, use tool output expand toggle)`;
	return edge === "head" ? `${shown}\n${hint}` : `${hint}\n${shown}`;
}

export function normalizeOutputText(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\n+$/g, "");
}
