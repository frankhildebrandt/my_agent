import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { LocalIndex } from "vectra";
import type { IndexItem, QueryResult } from "vectra";
import type { DebugCollector } from "./debug";
import { createEmbedding } from "./inference";
import type { AppSettings } from "./settings";

export interface ScriptRegistryEntry {
  path: string;
  description: string;
  usage: string;
  embedding: number[] | null;
  updatedAt: string;
}

interface ScriptRegistryFile {
  version: number;
  entries: ScriptRegistryEntry[];
}

interface SearchResult extends ScriptRegistryEntry {
  score: number;
  scoreSource: "embedding" | "lexical" | "recent";
}

interface ScriptRegistryMetadata {
  path: string;
  description: string;
  usage: string;
  updatedAt: string;
  [key: string]: string | number | boolean;
}

const EMPTY_REGISTRY: ScriptRegistryFile = {
  version: 1,
  entries: [],
};

function ensureScriptRegistryDirectory(settings: AppSettings): void {
  mkdirSync(dirname(settings.scriptRegistry.path), { recursive: true });
  mkdirSync(dirname(getScriptRegistryIndexPath(settings)), { recursive: true });
}

function getScriptRegistryIndexPath(settings: AppSettings): string {
  const configuredPath = settings.scriptRegistry.indexPath.trim();
  if (configuredPath.endsWith(".json")) {
    return configuredPath.replace(/\.json$/u, "");
  }

  return configuredPath;
}

function createScriptRegistryIndex(settings: AppSettings): LocalIndex<ScriptRegistryMetadata> {
  return new LocalIndex<ScriptRegistryMetadata>(getScriptRegistryIndexPath(settings));
}

async function ensureScriptRegistryIndex(
  settings: AppSettings,
): Promise<LocalIndex<ScriptRegistryMetadata>> {
  ensureScriptRegistryDirectory(settings);
  const index = createScriptRegistryIndex(settings);
  const isCreated = await index.isIndexCreated();

  if (!isCreated) {
    await index.createIndex({
      version: 1,
      metadata_config: {
        indexed: ["path", "description", "usage", "updatedAt"],
      },
    });
  }

  return index;
}

function toSearchResultFromVectraItem(
  item: IndexItem<ScriptRegistryMetadata>,
  score: number,
  scoreSource: SearchResult["scoreSource"],
): SearchResult {
  return {
    path: typeof item.metadata?.path === "string" ? item.metadata.path : item.id,
    description: typeof item.metadata?.description === "string" ? item.metadata.description : "",
    usage: typeof item.metadata?.usage === "string" ? item.metadata.usage : "",
    embedding: Array.isArray(item.vector) ? item.vector : null,
    updatedAt:
      typeof item.metadata?.updatedAt === "string" ? item.metadata.updatedAt : new Date().toISOString(),
    score,
    scoreSource,
  };
}

function toSearchResultFromVectraQuery(
  result: QueryResult<ScriptRegistryMetadata>,
  scoreSource: SearchResult["scoreSource"],
): SearchResult {
  return toSearchResultFromVectraItem(result.item, result.score, scoreSource);
}

async function migrateScriptRegistryIndexIfNeeded(settings: AppSettings): Promise<void> {
  const index = await ensureScriptRegistryIndex(settings);
  const currentItems = await index.listItems();
  if (currentItems.length > 0) {
    return;
  }

  const registry = loadScriptRegistryFile(settings);
  const migratableEntries = registry.entries.filter(
    (entry) => Array.isArray(entry.embedding) && entry.embedding.length > 0,
  );
  if (migratableEntries.length === 0) {
    return;
  }

  await index.beginUpdate();

  try {
    for (const entry of migratableEntries) {
      await index.upsertItem({
        id: entry.path,
        vector: entry.embedding ?? [],
        metadata: {
          path: entry.path,
          description: entry.description,
          usage: entry.usage,
          updatedAt: entry.updatedAt,
        },
      });
    }

    await index.endUpdate();
  } catch (error) {
    index.cancelUpdate();
    throw error;
  }
}

function loadScriptRegistryFile(settings: AppSettings): ScriptRegistryFile {
  ensureScriptRegistryDirectory(settings);

  if (!existsSync(settings.scriptRegistry.path)) {
    return EMPTY_REGISTRY;
  }

  const content = readFileSync(settings.scriptRegistry.path, "utf8");
  const parsed = JSON.parse(content) as Partial<ScriptRegistryFile>;
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    entries: entries.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const candidate = entry as Partial<ScriptRegistryEntry>;
      if (typeof candidate.path !== "string" || typeof candidate.description !== "string") {
        return [];
      }

      return [
        {
          path: candidate.path,
          description: candidate.description,
          usage: typeof candidate.usage === "string" ? candidate.usage : "",
          embedding: Array.isArray(candidate.embedding) ? candidate.embedding : null,
          updatedAt:
            typeof candidate.updatedAt === "string"
              ? candidate.updatedAt
              : new Date().toISOString(),
        },
      ];
    }),
  };
}

function saveScriptRegistryFile(settings: AppSettings, registry: ScriptRegistryFile): void {
  ensureScriptRegistryDirectory(settings);
  writeFileSync(settings.scriptRegistry.path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function getRegistryPathForScript(settings: AppSettings, absoluteScriptPath: string): string {
  return relative(resolve(settings.tools.scriptsDir), absoluteScriptPath).replace(/\\/gu, "/");
}

function buildEmbeddingText(path: string, description: string, usage: string): string {
  return [path, description, usage].join("\n");
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return -1;
  }

  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dotProduct += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return -1;
  }

  return dotProduct / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function lexicalScore(query: string, entry: ScriptRegistryEntry): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) {
    return 0;
  }

  const haystackTokens = new Set(tokenize(`${entry.path} ${entry.description}`));
  let hits = 0;

  for (const token of queryTokens) {
    if (haystackTokens.has(token)) {
      hits += 1;
    }
  }

  return hits / queryTokens.size;
}

export async function publishScriptRegistryEntry(
  settings: AppSettings,
  absoluteScriptPath: string,
  description: string,
  usage: string,
  debugCollector?: DebugCollector,
): Promise<{ entry: ScriptRegistryEntry; embeddingUsed: boolean }> {
  const registry = loadScriptRegistryFile(settings);
  const path = getRegistryPathForScript(settings, absoluteScriptPath);
  let embedding: number[] | null = null;
  let embeddingUsed = false;

  try {
    embedding = await createEmbedding(
      settings,
      buildEmbeddingText(path, description, usage),
      debugCollector,
      {
        purpose: "script_registry_publish",
        scope: path,
        tier: "scriptRegistry",
      },
    );
    embeddingUsed = true;
  } catch {
    embedding = null;
  }

  const entry: ScriptRegistryEntry = {
    path,
    description,
    usage,
    embedding,
    updatedAt: new Date().toISOString(),
  };

  const existingIndex = registry.entries.findIndex((candidate) => candidate.path === path);
  if (existingIndex >= 0) {
    registry.entries[existingIndex] = entry;
  } else {
    registry.entries.push(entry);
  }

  saveScriptRegistryFile(settings, registry);

  if (embedding && embedding.length > 0) {
    const index = await ensureScriptRegistryIndex(settings);
    await index.upsertItem({
      id: path,
      vector: embedding,
      metadata: {
        path,
        description,
        usage,
        updatedAt: entry.updatedAt,
      },
    });
  }

  return { entry, embeddingUsed };
}

export async function queryScriptRegistry(
  settings: AppSettings,
  query: string,
  topK = settings.scriptRegistry.topK,
  debugCollector?: DebugCollector,
): Promise<SearchResult[]> {
  const registry = loadScriptRegistryFile(settings);
  const limit = Math.max(1, Math.min(topK, 20));

  if (registry.entries.length === 0) {
    return [];
  }

  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    try {
      await migrateScriptRegistryIndexIfNeeded(settings);
      const index = await ensureScriptRegistryIndex(settings);
      const items = await index.listItems();
      if (items.length > 0) {
        return items
          .map((item) => toSearchResultFromVectraItem(item, 1, "recent"))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, limit);
      }
    } catch {
      // Fallback bleibt die JSON-Registry.
    }

    return [...registry.entries]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        score: 1,
        scoreSource: "recent" as const,
      }));
  }

  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await createEmbedding(settings, trimmedQuery, debugCollector, {
      purpose: "script_registry_query",
      scope: trimmedQuery,
      tier: "scriptRegistry",
    });
  } catch {
    queryEmbedding = null;
  }

  if (queryEmbedding && queryEmbedding.length > 0) {
    try {
      await migrateScriptRegistryIndexIfNeeded(settings);
      const index = await ensureScriptRegistryIndex(settings);
      const items = await index.listItems();
      if (items.length > 0) {
        return (await index.queryItems(queryEmbedding, trimmedQuery, limit))
          .map((result) => toSearchResultFromVectraQuery(result, "embedding"))
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }

            return right.updatedAt.localeCompare(left.updatedAt);
          });
      }
    } catch {
      // Fallback unten nutzt die bestehende JSON-Registry.
    }
  }

  return registry.entries
    .map((entry) => {
      if (queryEmbedding && entry.embedding) {
        return {
          ...entry,
          score: cosineSimilarity(queryEmbedding, entry.embedding),
          scoreSource: "embedding" as const,
        };
      }

      return {
        ...entry,
        score: lexicalScore(trimmedQuery, entry),
        scoreSource: "lexical" as const,
      };
    })
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit);
}
