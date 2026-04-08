import type { DebugCollector } from "../../debug";
import type { IScriptRegistryRepository } from "../../domain/ports";
import { publishScriptRegistryEntry } from "../../scriptRegistry";
import type { AppSettings } from "../../settings";

export class ScriptRegistryRepository implements IScriptRegistryRepository {
  async publish(
    settings: AppSettings,
    absoluteScriptPath: string,
    description: string,
    usage: string,
    debugCollector?: DebugCollector,
  ): Promise<{ embeddingUsed: boolean }> {
    const publication = await publishScriptRegistryEntry(
      settings,
      absoluteScriptPath,
      description,
      usage,
      debugCollector,
    );

    return {
      embeddingUsed: publication.embeddingUsed,
    };
  }
}

