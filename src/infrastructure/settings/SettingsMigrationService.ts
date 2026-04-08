import type { AppSettings } from "../../settings";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SettingsMigrationService {
  migrateLegacySettings(parsedSettings: unknown): unknown {
    if (!isJsonObject(parsedSettings)) {
      return parsedSettings;
    }

    const migratedSettings: JsonObject = { ...parsedSettings };
    const memory = migratedSettings.memory;

    if (!isJsonObject(memory)) {
      return migratedSettings;
    }

    if (isJsonObject(memory.shortTerm) || isJsonObject(memory.midTerm) || isJsonObject(memory.longTerm)) {
      return migratedSettings;
    }

    const legacyDir = typeof memory.dir === "string" ? memory.dir : "./agent_memory";
    const legacyIndexPath =
      typeof memory.indexPath === "string" ? memory.indexPath : "./agent_memory/index.json";
    const legacyTopK = typeof memory.topK === "number" ? memory.topK : 5;
    const legacyMaxTotalChars =
      typeof memory.maxTotalChars === "number" ? memory.maxTotalChars : 8000;
    const legacyMaxCharsPerFile =
      typeof memory.maxCharsPerFile === "number" ? memory.maxCharsPerFile : 2000;

    migratedSettings.memory = {
      shortTerm: {
        mode: "hybrid",
        maxTotalChars: Math.min(legacyMaxTotalChars, 4000),
        persistPath: `${legacyDir.replace(/\/+$/u, "")}/short_term_memory.json`,
      },
      midTerm: {
        dir: `${legacyDir.replace(/\/+$/u, "")}/mid_term_memory`,
        indexPath: legacyIndexPath.replace(/index\.json$/u, "mid_term_index"),
        topK: legacyTopK,
        maxFragmentChars: legacyMaxCharsPerFile,
        maxTotalChars: Math.min(legacyMaxTotalChars, 5000),
        maxFragmentsPerSleep: 10,
        maxEntries: 24,
      },
      longTerm: {
        dir: `${legacyDir.replace(/\/+$/u, "")}/long_term_memory`,
        indexPath: legacyIndexPath.replace(/index\.json$/u, "long_term_index"),
        topK: legacyTopK,
        maxFragmentChars: legacyMaxCharsPerFile,
        maxTotalChars: legacyMaxTotalChars,
        maxFragmentsPerSleep: 8,
      },
    } satisfies AppSettings["memory"];

    return migratedSettings;
  }
}

