/**
 * Shared helpers for commands that spin up child sessions.
 *
 * Invariants:
 * - Session names are whitespace-normalized and length-capped.
 * - Generation runs behind a cancellable loader; abort/failure yields null.
 * - Child sessions track the current session as parent.
 */
import { writeFile } from "node:fs/promises";

import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { extractMessageText } from "./message-text";

const MAX_SESSION_NAME_LENGTH = 60;

export type SessionInfo = {
	readonly sessionId: string;
	readonly sessionName: string | undefined;
};

/** Normalize whitespace and cap length for a session display name. */
export function deriveSessionName(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_SESSION_NAME_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, MAX_SESSION_NAME_LENGTH - 1).trimEnd()}\u2026`;
}

/** Return null on cancellation or failure without changes to the session model. */
export async function generateWithLoader(
	ctx: ExtensionContext,
	options: {
		readonly loaderMessage: string;
		readonly systemPrompt: string;
		readonly userText: string;
		readonly model?: Model<Api> | undefined;
	},
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, options.loaderMessage);
		loader.onAbort = () => done(null);

		const run = async (): Promise<string | null> => {
			const model = options.model ?? ctx.model;
			if (!model) {
				throw new Error("Invalid model");
			}

			const userMessage: Message = {
				role: "user",
				content: [{ type: "text", text: options.userText }],
				timestamp: Date.now(),
			};

			const response = await ctx.modelRegistry
				.streamSimple(
					model,
					{ systemPrompt: options.systemPrompt, messages: [userMessage] },
					{ signal: loader.signal },
				)
				.result();

			if (response.stopReason === "aborted") {
				return null;
			}

			return extractMessageText(response.content, "\n");
		};

		run()
			.then(done)
			.catch((err) => {
				console.error(`${options.loaderMessage} failed:`, err);
				done(null);
			});

		return loader;
	});
}

/** Custom message entry seeded into a child session as background context. */
export type SeedContextEntry = {
	readonly customType: string;
	readonly content: string;
};

/**
 * Open a named child session tracking the current session as parent.
 *
 * When `contextEntry` is provided, its content is seeded as a custom_message
 * entry. Like a branch summary, that entry participates in LLM context but does
 * not start a turn: the agent runs only when a subsequent real user message is
 * submitted. Unlike a branch summary, the framing text is fully caller-
 * controlled (no hardcoded prefix). Omit it for an empty child session. An
 * optional ready notice fires afterward.
 *
 * Returns whether the new session was cancelled.
 *
 * The captured pi/ctx is stale after newSession() returns: naming and context
 * seeding happen in setup (against the new SessionManager before replacement)
 * and the notice uses the fresh replacement ctx.
 */
export async function openChildSession(
	ctx: ExtensionCommandContext,
	options: {
		readonly name: string;
		readonly contextEntry?: SeedContextEntry | undefined;
		readonly readyNotice?: string | undefined;
	},
): Promise<{ cancelled: boolean }> {
	const parentSession = ctx.sessionManager.getSessionFile();
	const { name, contextEntry, readyNotice } = options;
	return ctx.newSession({
		parentSession,
		setup: async (sessionManager) => {
			sessionManager.appendSessionInfo(name);
			if (contextEntry !== undefined) {
				sessionManager.appendCustomMessageEntry(
					contextEntry.customType,
					contextEntry.content,
					true,
				);
			}
		},
		withSession:
			readyNotice === undefined
				? undefined
				: async (replacementCtx) => {
						replacementCtx.ui.notify(readyNotice, "info");
					},
	});
}

/**
 * Shared flow for handoff-style commands: let the user review/edit
 * caller-generated text in the current session, then create a child session
 * seeding the edited text as a non-turn context entry.
 *
 * Returns `{ cancelled: true }` when the user aborts the editor or an extension
 * cancels the new session; the child session is created only on accept.
 */
export async function editAndSeedChildSession(
	ctx: ExtensionCommandContext,
	options: {
		readonly editorTitle: string;
		readonly generated: string;
		readonly name: string;
		readonly customType: string;
		readonly readyNotice?: string | undefined;
		/** Maps the edited text to the content seeded into the child session. */
		readonly toContent?: ((edited: string) => string) | undefined;
	},
): Promise<{ cancelled: boolean }> {
	const edited = await ctx.ui.editor(options.editorTitle, options.generated);
	if (edited === undefined) {
		return { cancelled: true };
	}
	const content = options.toContent ? options.toContent(edited) : edited.trim();
	return openChildSession(ctx, {
		name: options.name,
		contextEntry: { customType: options.customType, content },
		readyNotice: options.readyNotice,
	});
}

export async function flushSessionFile(
	session: SessionManager,
): Promise<string | undefined> {
	const file = session.getSessionFile();
	if (file === undefined) {
		return undefined;
	}
	await writeFile(
		file,
		`${[session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		{ flag: "wx" },
	);
	return file;
}
