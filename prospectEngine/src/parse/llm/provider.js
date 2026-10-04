import { createDisabledProvider } from "./disabled.js";
import { createGeminiProvider } from "./gemini.js";
import { createOpenaiProvider } from "./openai.js";

export function createProvider(config) {
  if (!config.llmEnabled) {
    return createDisabledProvider();
  }

  switch (config.llmProvider) {
    case "gemini":
      return createGeminiProvider(config);

    case "openai":
      return createOpenaiProvider(config);

    default:
      throw new Error(
        `Unknown LLM_PROVIDER: ${config.llmProvider}`
      );
  }
}

// OpenAI provider for fact extraction (search planning, relevance, company
// profiles); disabled unless OpenAI is enabled and configured.
export function createFactsProvider(config) {
  if (!config.relevanceEnabled || !config.openaiEnabled || !config.openaiApiKey) {
    return createDisabledProvider();
  }

  return createOpenaiProvider(config);
}
