import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildSessionContext,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { generateWithLoader } from "./session";

const HANDOFF_MODEL_ID = "fast";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on the user's goal]`;

export async function generateHandoffPrompt(
	ctx: ExtensionContext,
	goal: string,
): Promise<string | null> {
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
	return generateWithLoader(ctx, {
		model,
		loaderMessage: "Generating handoff prompt...",
		systemPrompt: SYSTEM_PROMPT,
		userText: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
	});
}
