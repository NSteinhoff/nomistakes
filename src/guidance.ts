import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function guidance(pi: ExtensionAPI): Promise<void> {
	const markdown = await readFile(
		new URL("./guidance.md", import.meta.url),
		"utf8",
	);
	const sections = new Map<string, string[]>();
	let content: string[] = [];

	for (const line of markdown.split(/\r?\n/)) {
		if (line.startsWith("# ")) {
			const name = line
				.slice(2)
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "");
			content = [];
			sections.set(name, content);
		} else {
			content.push(line);
		}
	}

	pi.on("before_agent_start", async (event) => {
		for (const [name, lines] of sections) {
			event.systemPromptOptions.sections[name] = lines.join("\n").trim();
		}
	});
}
