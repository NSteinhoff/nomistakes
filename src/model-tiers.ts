import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type {
	ExtensionAPI,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";

const MODEL_TIERS = {
	anthropic: {
		fast: "claude-haiku-5-5",
		smart: "claude-opus-5-5",
		ultra: "claude-fable-5-2",
	},
	"openai-codex": {
		fast: "gpt-6-luna",
		smart: "gpt-6.2-sol",
		ultra: "gpt-6.2-astra",
	},
} as const;

const STARTUP_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export default function (pi: ExtensionAPI): void {
	// Pi resolves model selections before it emits session_start.
	registerTiers(pi);
	pi.on("session_start", (_event, ctx) => {
		registerTiers(pi, ctx.modelRegistry);
	});
}

function registerTiers(pi: ExtensionAPI, registry?: ModelRegistry): void {
	for (const [provider, tiers] of Object.entries(MODEL_TIERS)) {
		for (const [tier, modelId] of Object.entries(tiers)) {
			let thinkingLevels = STARTUP_THINKING_LEVELS;
			if (registry) {
				const target = registry.find(provider, modelId);
				if (!target) continue;
				thinkingLevels = getSupportedThinkingLevels(target);
			}

			pi.registerVirtualModel({
				provider,
				id: tier,
				name: tier,
				thinkingLevels,
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
