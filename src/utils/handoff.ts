import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { deriveSessionName, generateWithLoader } from "./session";

const HANDOFF_MODEL_ID = "fast";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation
5. Excludes prior workflow requests unless the new goal explicitly includes them

Return only a JSON object with two string fields: "title" and "prompt". Use a short, descriptive title for the task. Make the prompt self-contained and concise. Do not include a preamble or Markdown fences around the JSON.

Example format for the prompt field:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on the user's goal]`;

export type Handoff = {
	readonly title: string;
	readonly prompt: string;
};

export async function generateHandoff(
	ctx: ExtensionContext,
	goal: string,
): Promise<Handoff | null> {
	const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
	if (messages.length === 0) {
		ctx.ui.notify("No conversation to hand off", "error");
		return null;
	}
	const provider = ctx.model?.provider;
	if (provider === undefined) {
		ctx.ui.notify("No model selected", "error");
		return null;
	}
	const model = ctx.modelRegistry.find(provider, HANDOFF_MODEL_ID);
	if (model === undefined) {
		ctx.ui.notify(
			`No ${HANDOFF_MODEL_ID} model registered for ${provider}.`,
			"error",
		);
		return null;
	}
	const conversationText = serializeConversation(convertToLlm(messages));
	const generated = await generateWithLoader(ctx, {
		model,
		loaderMessage: "Generating handoff prompt...",
		systemPrompt: SYSTEM_PROMPT,
		userText: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
	});
	if (generated === null) {
		return null;
	}

	let value: unknown;
	try {
		value = JSON.parse(generated);
	} catch {
		ctx.ui.notify("Invalid handoff response. Expected JSON.", "error");
		return null;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("prompt" in value) ||
		typeof value.prompt !== "string" ||
		!value.prompt.trim()
	) {
		ctx.ui.notify("Invalid handoff response. No prompt supplied.", "error");
		return null;
	}
	const title =
		"title" in value && typeof value.title === "string"
			? value.title.trim()
			: "";
	return {
		title: deriveSessionName(title || goal),
		prompt: value.prompt.trim(),
	};
}
