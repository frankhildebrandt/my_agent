import type { AppSettings, ModelConfig, ProviderConfig } from "../../settings";
import { InferenceError } from "./InferenceError";

export interface ResolvedModel {
  modelConfig: ModelConfig;
  providerName: string;
  providerConfig: ProviderConfig;
}

export class ProviderCatalog {
  resolveModel(settings: AppSettings, modelAlias: string): ResolvedModel {
    const modelConfig = settings.llm.models[modelAlias];
    if (!modelConfig) {
      throw new InferenceError(`Unbekanntes Modell-Alias: ${modelAlias}`);
    }

    const providerConfig = settings.llm.providers[modelConfig.provider];
    if (!providerConfig) {
      throw new InferenceError(
        `Provider '${modelConfig.provider}' fuer Modell '${modelAlias}' ist nicht konfiguriert.`,
      );
    }

    return {
      modelConfig,
      providerName: modelConfig.provider,
      providerConfig,
    };
  }
}
