import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODEL_TIERS = {
	anthropic: {
		fast: "claude-haiku-4-5",
		smart: "claude-sonnet-5-5",
		ultra: "claude-opus-5-5",
	},
	"openai-codex": {
		fast: "gpt-6-luna",
		smart: "gpt-6.1-sol",
		ultra: "gpt-6-astra",
	},
} as const;

const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export default function (pi: ExtensionAPI): void {
	for (const [provider, tiers] of Object.entries(MODEL_TIERS)) {
		for (const [tier, modelId] of Object.entries(tiers)) {
			pi.registerVirtualModel({
				provider,
				id: tier,
				name: tier,
				thinkingLevels: THINKING_LEVELS,
				route(request, ctx) {
					const model = ctx.modelRegistry.find(provider, modelId);
					if (!model) {
						throw new Error(
							`Model tier ${provider}/${tier} targets unknown model ${provider}/${modelId}.`,
						);
					}
					return { model, thinkingLevel: request.thinkingLevel };
				},
			});
		}
	}
}
