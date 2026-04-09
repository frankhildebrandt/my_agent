import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { ISettingsRepository } from "../../domain/ports";
import { AppSettings } from "../../settings";
import { SettingsMigrationService } from "./SettingsMigrationService";

type JsonObject = Record<string, unknown>;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isJsonObject(base) || !isJsonObject(override)) {
    return (override ?? base) as T;
  }

  const merged: JsonObject = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];

    if (isJsonObject(current) && isJsonObject(value)) {
      merged[key] = deepMerge(current, value);
      continue;
    }

    merged[key] = value;
  }

  return merged as T;
}

function shortenUnixSocketPath(socketPath: string): string {
  if (Buffer.byteLength(socketPath, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return socketPath;
  }

  const extension = extname(socketPath) || ".sock";
  const fileName = basename(socketPath, extension);
  const safeName = fileName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "control";
  const suffix = createHash("sha256").update(socketPath).digest("hex").slice(0, 12);
  return resolve(tmpdir(), `${safeName}-${suffix}${extension}`);
}

export class FileSettingsRepository implements ISettingsRepository {
  constructor(
    private readonly defaults: AppSettings,
    private readonly migrationService: SettingsMigrationService,
    private readonly fileName = "settings.json",
  ) {}

  load(): AppSettings {
    const diskPath = resolve(process.cwd(), this.fileName);
    let parsedSettings: unknown = {};

    if (existsSync(diskPath)) {
      const content = readFileSync(diskPath, "utf8");
      parsedSettings = this.migrationService.migrateLegacySettings(JSON.parse(content) as unknown);
    }

    const mergedSettings = this.normalizeSettings(deepMerge(this.defaults, parsedSettings));
    writeFileSync(diskPath, `${JSON.stringify(mergedSettings, null, 2)}\n`, "utf8");
    return mergedSettings;
  }

  private normalizeSettings(settings: AppSettings): AppSettings {
    const settingsPath = settings.files.settingsPath.trim();
    const shortTermPersistPath = settings.memory.shortTerm.persistPath.trim();
    const midTermDir = settings.memory.midTerm.dir.trim();
    const midTermIndexPath = settings.memory.midTerm.indexPath.trim();
    const longTermDir = settings.memory.longTerm.dir.trim();
    const longTermIndexPath = settings.memory.longTerm.indexPath.trim();
    const modulesDir = settings.modules.dir.trim();
    const modulePolicyPath = settings.modules.policyPath.trim();
    const controlSocketPath = settings.controlSocket.path.trim();
    const scriptRegistryPath = settings.scriptRegistry.path.trim();
    const scriptRegistryIndexPath = settings.scriptRegistry.indexPath.trim();
    const scriptsDir = settings.tools.scriptsDir.trim();

    return {
      ...settings,
      files: {
        ...settings.files,
        settingsPath: settingsPath.length > 0 ? resolve(process.cwd(), settingsPath) : resolve(process.cwd(), this.fileName),
      },
      memory: {
        shortTerm: {
          ...settings.memory.shortTerm,
          persistPath:
            shortTermPersistPath.length > 0
              ? resolve(process.cwd(), shortTermPersistPath)
              : resolve(process.cwd(), "agent_memory", "short_term_memory.json"),
        },
        midTerm: {
          ...settings.memory.midTerm,
          dir:
            midTermDir.length > 0
              ? resolve(process.cwd(), midTermDir)
              : resolve(process.cwd(), "agent_memory", "mid_term_memory"),
          indexPath:
            midTermIndexPath.length > 0
              ? resolve(process.cwd(), midTermIndexPath)
              : resolve(process.cwd(), "agent_memory", "mid_term_index"),
        },
        longTerm: {
          ...settings.memory.longTerm,
          dir:
            longTermDir.length > 0
              ? resolve(process.cwd(), longTermDir)
              : resolve(process.cwd(), "agent_memory", "long_term_memory"),
          indexPath:
            longTermIndexPath.length > 0
              ? resolve(process.cwd(), longTermIndexPath)
              : resolve(process.cwd(), "agent_memory", "long_term_index"),
        },
      },
      modules: {
        ...settings.modules,
        dir: modulesDir.length > 0 ? resolve(process.cwd(), modulesDir) : resolve(process.cwd(), "agent_modules"),
        policyPath:
          modulePolicyPath.length > 0
            ? resolve(process.cwd(), modulePolicyPath)
            : resolve(process.cwd(), "agent_modules", "policy.json"),
      },
      controlSocket: {
        ...settings.controlSocket,
        path:
          controlSocketPath.length > 0
            ? shortenUnixSocketPath(resolve(process.cwd(), controlSocketPath))
            : shortenUnixSocketPath(resolve(process.cwd(), "agent_socket", "control.sock")),
      },
      scriptRegistry: {
        ...settings.scriptRegistry,
        path:
          scriptRegistryPath.length > 0
            ? resolve(process.cwd(), scriptRegistryPath)
            : resolve(process.cwd(), "agent_scripts", "registry.json"),
        indexPath:
          scriptRegistryIndexPath.length > 0
            ? resolve(process.cwd(), scriptRegistryIndexPath)
            : resolve(process.cwd(), "agent_scripts", "registry_index"),
      },
      tools: {
        ...settings.tools,
        scriptsDir:
          scriptsDir.length > 0 ? resolve(process.cwd(), scriptsDir) : resolve(process.cwd(), "agent_scripts"),
      },
    };
  }
}
