import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AskUserQuestionDetails {
	question: string;
	answer: string | null;
	cancelled: boolean;
	mode: "confirm" | "select" | "input" | "editor";
	options?: string[];
}

const AskUserQuestionParams = Type.Object({
	question: Type.String({ description: "Question to ask the user." }),
	placeholder: Type.Optional(
		Type.String({ description: "Placeholder for text input." }),
	),
	initialValue: Type.Optional(
		Type.String({
			description: "Optional prefilled value. Uses editor UI when provided.",
		}),
	),
	multiline: Type.Optional(
		Type.Boolean({
			description: "Use a multi-line editor for free-form answers.",
		}),
	),
	confirmOnly: Type.Optional(
		Type.Boolean({
			description:
				"Strict yes/no confirmation. Cancel is unsupported by confirm API.",
		}),
	),
	options: Type.Optional(
		Type.Array(Type.String({ description: "Selectable option." }), {
			description: "Optional choices for the user.",
		}),
	),
	allowCustomAnswer: Type.Optional(
		Type.Boolean({
			description: "With options, allow a custom answer. Defaults to true.",
		}),
	),
});

async function promptForNonEmptyAnswer(
	ctx: ExtensionContext,
	question: string,
	placeholder: string | undefined,
	initialValue: string | undefined,
	multiline: boolean | undefined,
): Promise<{ answer: string | null; mode: "input" | "editor" }> {
	const useEditor = multiline || initialValue !== undefined;
	const mode: "input" | "editor" = useEditor ? "editor" : "input";

	while (true) {
		const answer = useEditor
			? await ctx.ui.editor(question, initialValue ?? "")
			: await ctx.ui.input(question, placeholder);
		if (answer === undefined) {
			return { answer: null, mode };
		}
		if (answer.trim().length > 0) {
			return { answer: answer.trim(), mode };
		}
		ctx.ui.notify(
			"Answer cannot be empty. Enter a value or cancel.",
			"warning",
		);
	}
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		exposure: "model-only",
		label: "Ask User Question",
		description:
			"Prompt the user via Pi UI for missing requirements, preferences, approvals, or blocking decisions. Returns the answer.",
		parameters: AskUserQuestionParams,
		// Forces the whole tool-call batch to run one at a time: ask drives
		// blocking UI prompts that cannot share the terminal with concurrent calls.
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "Error: UI is not available, so the user cannot be prompted.",
						},
					],
					details: {
						question: params.question,
						answer: null,
						cancelled: true,
						mode: "input",
						options: params.options,
					} satisfies AskUserQuestionDetails,
				};
			}

			if (params.confirmOnly) {
				// confirm API is boolean-only, so this mode is strict yes/no.
				const confirmed = await ctx.ui.confirm(
					params.question,
					params.placeholder ?? "Confirm to continue",
				);
				return {
					content: [
						{
							type: "text",
							text: confirmed ? "User confirmed: yes" : "User answered: no",
						},
					],
					details: {
						question: params.question,
						answer: confirmed ? "yes" : "no",
						cancelled: false,
						mode: "confirm",
					} satisfies AskUserQuestionDetails,
				};
			}

			const options = (params.options ?? []).filter(
				(option) => option.trim().length > 0,
			);
			if (options.length > 0) {
				const allowCustomAnswer = params.allowCustomAnswer !== false;
				const customLabel = "Type your own answer…";
				const displayedOptions = allowCustomAnswer
					? [...options, customLabel]
					: options;
				const choice = await ctx.ui.select(params.question, displayedOptions);

				if (!choice) {
					return {
						content: [{ type: "text", text: "User cancelled the question." }],
						details: {
							question: params.question,
							answer: null,
							cancelled: true,
							mode: "select",
							options,
						} satisfies AskUserQuestionDetails,
					};
				}

				if (allowCustomAnswer && choice === customLabel) {
					const customAnswerResult = await promptForNonEmptyAnswer(
						ctx,
						params.question,
						params.placeholder,
						params.initialValue,
						params.multiline,
					);

					if (customAnswerResult.answer === null) {
						return {
							content: [{ type: "text", text: "User cancelled the question." }],
							details: {
								question: params.question,
								answer: null,
								cancelled: true,
								mode: customAnswerResult.mode,
								options,
							} satisfies AskUserQuestionDetails,
						};
					}

					return {
						content: [
							{
								type: "text",
								text: `User answered: ${customAnswerResult.answer}`,
							},
						],
						details: {
							question: params.question,
							answer: customAnswerResult.answer,
							cancelled: false,
							mode: customAnswerResult.mode,
							options,
						} satisfies AskUserQuestionDetails,
					};
				}

				return {
					content: [{ type: "text", text: `User selected: ${choice}` }],
					details: {
						question: params.question,
						answer: choice,
						cancelled: false,
						mode: "select",
						options,
					} satisfies AskUserQuestionDetails,
				};
			}

			const answerResult = await promptForNonEmptyAnswer(
				ctx,
				params.question,
				params.placeholder,
				params.initialValue,
				params.multiline,
			);

			if (answerResult.answer === null) {
				return {
					content: [{ type: "text", text: "User cancelled the question." }],
					details: {
						question: params.question,
						answer: null,
						cancelled: true,
						mode: answerResult.mode,
					} satisfies AskUserQuestionDetails,
				};
			}

			return {
				content: [
					{ type: "text", text: `User answered: ${answerResult.answer}` },
				],
				details: {
					question: params.question,
					answer: answerResult.answer,
					cancelled: false,
					mode: answerResult.mode,
				} satisfies AskUserQuestionDetails,
			};
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			const header = details.question
				.split(/\r?\n/)
				.map((line) => theme.fg("muted", line))
				.join("\n");

			if (details.cancelled || details.answer === null) {
				return new Text(`${header}\n${theme.fg("warning", "Cancelled")}`, 0, 0);
			}

			return new Text(
				`${header}\n${theme.fg("success", "✓ ")}${theme.fg("accent", details.answer)}`,
				0,
				0,
			);
		},
	});
}
