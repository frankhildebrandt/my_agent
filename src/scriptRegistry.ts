import type { DebugCollector } from "./debug";
import type { ScriptRegistryEntry, ScriptRegistrySearchResult } from "./domain/scriptRegistryTypes";
import { ScriptRegistryService } from "./infrastructure/scriptRegistry/ScriptRegistryService";
import type { AppSettings } from "./settings";

export type { ScriptRegistryEntry, ScriptRegistrySearchResult } from "./domain/scriptRegistryTypes";

const scriptRegistryService = new ScriptRegistryService();

export async function publishScriptRegistryEntry(
  settings: AppSettings,
  absoluteScriptPath: string,
  description: string,
  usage: string,
  debugCollector?: DebugCollector,
): Promise<{ entry: ScriptRegistryEntry; embeddingUsed: boolean }> {
  return scriptRegistryService.publishScriptRegistryEntry(
    settings,
    absoluteScriptPath,
    description,
    usage,
    debugCollector,
  );
}

export async function queryScriptRegistry(
  settings: AppSettings,
  query: string,
  topK = settings.scriptRegistry.topK,
  debugCollector?: DebugCollector,
): Promise<ScriptRegistrySearchResult[]> {
  return scriptRegistryService.queryScriptRegistry(settings, query, topK, debugCollector);
}
