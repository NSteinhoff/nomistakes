type ContentBlock = {
	readonly type: string;
	readonly text?: string | undefined;
};

export function extractMessageText(
	content: string | readonly ContentBlock[],
	separator: string,
): string {
	if (typeof content === "string") return content;

	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text !== undefined) {
			parts.push(block.text);
		}
	}
	return parts.join(separator);
}
