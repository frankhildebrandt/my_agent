import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { LocalIndex } from "vectra";
import type { IndexItem, QueryResult } from "vectra";
import type { DebugCollector } from "./debug";
import { createEmbedding } from "./inference";
import type { AppSettings } from "./settings";

export interface ShortTermConversationEntry {
  role: "user" | "assistant" | "tool" | "system";
  kind?:
    | "message"
    | "model_request"
    | "model_response"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "usage"
    | "loop_correction"
    | "status";
  content: string;
  createdAt: string;
  includeInPrompt?: boolean;
  metadata?: Record<string, unknown>;
}

interface ShortTermMemoryEntry extends ShortTermConversationEntry {
  id: string;
}

interface ShortTermMemoryFile {
  version: number;
  entries: ShortTermMemoryEntry[];
}

type ShortTermMetadataValue =
  | string
  | number
  | boolean
  | null
  | ShortTermMetadataObject
  | ShortTermMetadataValue[];

export interface ShortTermMetadataObject {
  [key: string]: ShortTermMetadataValue;
}

interface LongTermMemoryEntry {
  id: string;
  title: string;
  path: string;
  excerpt: string;
  updatedAt: string;
  accessCount?: number;
  lastAccessedAt?: string;
}

type MemoryTier = "midTerm" | "longTerm";

interface LongTermMemoryMetadata {
  title: string;
  path: string;
  excerpt: string;
  updatedAt: string;
  accessCount?: number;
  lastAccessedAt?: string;
  [key: string]: string | number | boolean;
}

interface LegacyLongTermMemoryEntry {
  path?: string;
  embedding?: number[] | null;
  excerpt?: string;
  updatedAt?: string;
}

interface RankedLongTermEntry extends LongTermMemoryEntry {
  score: number;
  scoreSource: "embedding" | "lexical" | "recent";
  accessCount?: number;
  lastAccessedAt?: string;
}

export interface MemoryDebugFragment {
  id: string;
  title: string;
  path: string;
  score: number;
  scoreSource: "embedding" | "lexical" | "recent";
}

export interface TierMemoryDebugInfo {
  tier: MemoryTier;
  query: string;
  retrievalMode: "embedding" | "lexical" | "recent" | "empty";
  embeddingAttempted: boolean;
  embeddingSucceeded: boolean;
  usedEntries: MemoryDebugFragment[];
  text: string;
}

export interface TierMemoryContextResult {
  text: string;
  debug: TierMemoryDebugInfo;
}

export interface ShortTermMemorySourceDebugInfo {
  source: "buffer" | "conversation";
  text: string;
}

export interface ShortTermMemoryDebugInfo {
  mode: AppSettings["memory"]["shortTerm"]["mode"];
  sources: ShortTermMemorySourceDebugInfo[];
  text: string;
}

export interface ShortTermMemorySnapshotResult {
  text: string;
  debug: ShortTermMemoryDebugInfo;
}

export interface LongTermFragmentDraft {
  title: string;
  content: string;
}

export interface StoredLongTermFragment {
  id: string;
  title: string;
  path: string;
  content: string;
  embeddingUsed: boolean;
  action: "created" | "updated";
}

const EMPTY_SHORT_TERM_MEMORY: ShortTermMemoryFile = {
  version: 2,
  entries: [],
};

const SHORT_TERM_ENTRY_MAX_CHARS = 800;

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function trimToLength(content: string, maxChars: number): string {
  return content.trim().replace(/\s+\n/gu, "\n").slice(0, maxChars);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function lexicalScore(query: string, haystack: string): number {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) {
    return 0;
  }

  const haystackTokens = new Set(tokenize(haystack));
  let hits = 0;

  for (const token of queryTokens) {
    if (haystackTokens.has(token)) {
      hits += 1;
    }
  }

  return hits / queryTokens.size;
}

function normalizedMemoryText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function countUniqueTokens(value: string): number {
  return new Set(tokenize(value)).size;
}

function countSentences(value: string): number {
  return value
    .split(/[.!?]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

function hasReusableArtifactReference(value: string): boolean {
  return /(?:^|\s)(?:[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|json|md)|--[\w-]+|\/[\w./-]+|query_script_registry|run_typescript_file|create_typescript_file)(?:$|\s)/iu.test(
    value,
  );
}

function hasDurableInstructionSignal(value: string): boolean {
  return /\b(?:immer|nie|nur|bevor|danach|zuerst|statt|verwende|nutze|aufrufen|ausfuehren|geeignet|parameter|eingaben|zeitzone|konvention|regel|bewaehrt)\b/iu.test(
    value,
  );
}

function scoreFragmentUtility(title: string, content: string): number {
  const combined = `${title} ${content}`;
  const uniqueTokens = countUniqueTokens(combined);
  const sentences = countSentences(content);
  const denseSignals =
    (hasReusableArtifactReference(combined) ? 3 : 0) +
    (hasDurableInstructionSignal(combined) ? 1 : 0) +
    Math.min(uniqueTokens / 8, 3) +
    Math.min(sentences, 3) * 0.4;

  return denseSignals;
}

function isUsefulLongTermFragment(title: string, content: string): boolean {
  const combined = `${title} ${content}`;
  const uniqueTokens = countUniqueTokens(combined);
  const sentences = countSentences(content);
  const hasArtifact = hasReusableArtifactReference(combined);
  const hasDurableSignal = hasDurableInstructionSignal(combined);

  if (content.length < 80) {
    return false;
  }

  if (uniqueTokens < 10) {
    return false;
  }

  if (hasArtifact) {
    return true;
  }

  return hasDurableSignal && sentences >= 2 && uniqueTokens >= 16;
}

function dedupeFragmentDrafts(fragments: LongTermFragmentDraft[]): LongTermFragmentDraft[] {
  const ranked = fragments
    .map((fragment) => ({
      fragment: {
        title: normalizeTitle(fragment.title),
        content: trimToLength(fragment.content, Number.MAX_SAFE_INTEGER),
      },
      utility: scoreFragmentUtility(fragment.title, fragment.content),
    }))
    .filter(({ fragment }) => fragment.title.length > 0 && fragment.content.length > 0)
    .sort((left, right) => right.utility - left.utility);
  const kept: Array<{ fragment: LongTermFragmentDraft; utility: number }> = [];

  for (const candidate of ranked) {
    const normalizedTitle = normalizedMemoryText(candidate.fragment.title);
    const normalizedContent = normalizedMemoryText(candidate.fragment.content);
    const isDuplicate = kept.some((existing) => {
      const titleScore = lexicalScore(normalizedTitle, normalizedMemoryText(existing.fragment.title));
      const contentScore = lexicalScore(
        normalizedContent,
        normalizedMemoryText(existing.fragment.content),
      );
      return titleScore >= 0.8 || contentScore >= 0.88 || (titleScore >= 0.65 && contentScore >= 0.72);
    });

    if (!isDuplicate) {
      kept.push(candidate);
    }
  }

  return kept.map(({ fragment }) => fragment);
}

function buildEmbeddingText(title: string, excerpt: string): string {
  return [title, excerpt].join("\n");
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/gu, " ").trim();
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isValidShortTermMetadataValue(value: unknown): value is ShortTermMetadataValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry) => isValidShortTermMetadataValue(entry));
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.values(value).every((entry) => isValidShortTermMetadataValue(entry));
}

function sanitizeShortTermMetadataValue(value: unknown): ShortTermMetadataValue | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeShortTermMetadataValue(entry))
      .filter((entry): entry is ShortTermMetadataValue => entry !== undefined);
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const sanitizedEntries = Object.entries(value).flatMap(([key, entry]) => {
    const sanitized = sanitizeShortTermMetadataValue(entry);
    return sanitized === undefined ? [] : [[key, sanitized] as const];
  });

  return Object.fromEntries(sanitizedEntries);
}

function sanitizeShortTermMetadata(
  value: ShortTermConversationEntry["metadata"],
): ShortTermMetadataObject | undefined {
  const sanitized = sanitizeShortTermMetadataValue(value);
  if (!sanitized || Array.isArray(sanitized) || typeof sanitized !== "object") {
    return undefined;
  }

  return sanitized;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);

  return slug.length > 0 ? slug : "fragment";
}

function buildFragmentRelativePath(title: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return join("fragments", `${timestamp}-${slugify(title)}.md`).replace(/\\/gu, "/");
}

function normalizeRelativeLongTermPath(root: string, requestedPath: string): string {
  const trimmedPath = requestedPath.trim().replace(/\\/gu, "/");
  const rootDirName = basename(root).replace(/\\/gu, "/");
  const rootPrefix = `${rootDirName}/`;

  if (trimmedPath === rootDirName) {
    return "";
  }

  if (trimmedPath.startsWith(rootPrefix)) {
    return trimmedPath.slice(rootPrefix.length);
  }

  return trimmedPath;
}

function getTierSettings(settings: AppSettings, tier: MemoryTier): AppSettings["memory"]["midTerm"] | AppSettings["memory"]["longTerm"] {
  return tier === "midTerm" ? settings.memory.midTerm : settings.memory.longTerm;
}

function getVectorIndexPath(settings: AppSettings, tier: MemoryTier): string {
  const configuredPath = getTierSettings(settings, tier).indexPath.trim();
  if (configuredPath.endsWith(".json")) {
    return configuredPath.replace(/\.json$/u, "");
  }

  return configuredPath;
}

function getTierRelativePath(settings: AppSettings, tier: MemoryTier, absolutePath: string): string {
  return relative(resolve(getTierSettings(settings, tier).dir), absolutePath).replace(/\\/gu, "/");
}

function ensureShortTermStorage(settings: AppSettings): void {
  ensureDirectory(dirname(settings.memory.shortTerm.persistPath));
}

function ensureTierStorage(settings: AppSettings, tier: MemoryTier): void {
  const tierSettings = getTierSettings(settings, tier);
  ensureDirectory(tierSettings.dir);
  ensureDirectory(dirname(getVectorIndexPath(settings, tier)));
}

function createVectorIndex(settings: AppSettings, tier: MemoryTier): LocalIndex<LongTermMemoryMetadata> {
  return new LocalIndex<LongTermMemoryMetadata>(getVectorIndexPath(settings, tier));
}

async function ensureVectorIndex(
  settings: AppSettings,
  tier: MemoryTier,
): Promise<LocalIndex<LongTermMemoryMetadata>> {
  const index = createVectorIndex(settings, tier);
  const isCreated = await index.isIndexCreated();

  if (!isCreated) {
    await index.createIndex({
      version: 1,
      metadata_config: {
        indexed: ["title", "path", "updatedAt", "excerpt", "accessCount", "lastAccessedAt"],
      },
    });
  }

  return index;
}

function loadShortTermMemoryFile(settings: AppSettings): ShortTermMemoryFile {
  ensureShortTermStorage(settings);

  if (!existsSync(settings.memory.shortTerm.persistPath)) {
    return EMPTY_SHORT_TERM_MEMORY;
  }

  const content = readFileSync(settings.memory.shortTerm.persistPath, "utf8");
  const parsed = JSON.parse(content) as Partial<ShortTermMemoryFile>;
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    entries: entries.filter((entry): entry is ShortTermMemoryEntry => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }

      const candidate = entry as Partial<ShortTermMemoryEntry>;
      return (
        typeof candidate.id === "string" &&
        (candidate.role === "user" ||
          candidate.role === "assistant" ||
          candidate.role === "tool" ||
          candidate.role === "system") &&
        typeof candidate.content === "string" &&
        typeof candidate.createdAt === "string" &&
        (candidate.kind === undefined ||
          candidate.kind === "message" ||
          candidate.kind === "model_request" ||
          candidate.kind === "model_response" ||
          candidate.kind === "reasoning" ||
          candidate.kind === "tool_call" ||
          candidate.kind === "tool_result" ||
          candidate.kind === "usage" ||
          candidate.kind === "loop_correction" ||
          candidate.kind === "status") &&
        (candidate.includeInPrompt === undefined || typeof candidate.includeInPrompt === "boolean") &&
        (candidate.metadata === undefined || isValidShortTermMetadataValue(candidate.metadata))
      );
    }),
  };
}

function saveShortTermMemoryFile(settings: AppSettings, memoryFile: ShortTermMemoryFile): void {
  ensureShortTermStorage(settings);
  writeFileSync(settings.memory.shortTerm.persistPath, `${JSON.stringify(memoryFile, null, 2)}\n`, "utf8");
}

function pruneShortTermEntries(settings: AppSettings, entries: ShortTermMemoryEntry[]): ShortTermMemoryEntry[] {
  void settings;
  return entries;
}

function formatShortTermEntries(
  entries: Array<ShortTermConversationEntry | ShortTermMemoryEntry>,
  maxChars: number,
): string {
  const rendered: string[] = [];
  let usedChars = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }

    if (entry.includeInPrompt === false) {
      continue;
    }

    const block = `[${entry.role}${entry.kind ? `/${entry.kind}` : ""}] ${entry.content.trim()}`;

    if (block.length === 0) {
      continue;
    }

    const nextUsedChars = usedChars + block.length;
    if (nextUsedChars > maxChars && rendered.length > 0) {
      break;
    }

    rendered.unshift(block.slice(0, maxChars - usedChars));
    usedChars = nextUsedChars;
  }

  return rendered.join("\n");
}

function dedupeShortTermBlocks(blocks: string[]): string[] {
  const seen = new Set<string>();
  const uniqueBlocks: string[] = [];

  for (const block of blocks) {
    const normalized = block.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueBlocks.push(normalized);
  }

  return uniqueBlocks;
}

function isLegacyLongTermEntry(entry: unknown): entry is LegacyLongTermMemoryEntry {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  const candidate = entry as LegacyLongTermMemoryEntry;
  return typeof candidate.path === "string" && typeof candidate.excerpt === "string";
}

function loadLegacyTierEntries(
  settings: AppSettings,
  tier: MemoryTier,
): Array<LongTermMemoryEntry & { embedding: number[] | null }> {
  const tierSettings = getTierSettings(settings, tier);
  ensureTierStorage(settings, tier);

  if (!existsSync(tierSettings.indexPath)) {
    return [];
  }

  const stats = statSync(tierSettings.indexPath);
  if (!stats.isFile()) {
    return [];
  }

  const content = readFileSync(tierSettings.indexPath, "utf8");
  const parsed = JSON.parse(content) as { entries?: unknown[] };
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

  return entries.flatMap((entry) => {
    if (typeof entry === "object" && entry !== null) {
      const candidate = entry as Partial<LongTermMemoryEntry> & { embedding?: number[] | null };
      if (
        typeof candidate.id === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.path === "string" &&
        typeof candidate.excerpt === "string"
      ) {
        return [
          {
            id: candidate.id,
            title: candidate.title,
            path: candidate.path,
            excerpt: candidate.excerpt,
            embedding: Array.isArray(candidate.embedding) ? candidate.embedding : null,
            updatedAt:
              typeof candidate.updatedAt === "string"
                ? candidate.updatedAt
                : new Date().toISOString(),
          },
        ];
      }
    }

    if (isLegacyLongTermEntry(entry)) {
      const title = basename(entry.path ?? "", extname(entry.path ?? ""));
      return [
        {
          id: title.length > 0 ? title : `legacy-${Date.now()}`,
          title,
          path: entry.path ?? "",
          excerpt: entry.excerpt ?? "",
          embedding: Array.isArray(entry.embedding) ? entry.embedding : null,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
        },
      ];
    }

    return [];
  });
}

async function migrateLegacyLongTermIndexIfNeeded(
  settings: AppSettings,
  tier: MemoryTier,
  index: LocalIndex<LongTermMemoryMetadata>,
): Promise<void> {
  const currentItems = await index.listItems();
  if (currentItems.length > 0) {
    return;
  }

  const legacyEntries = loadLegacyTierEntries(settings, tier);
  if (legacyEntries.length === 0) {
    return;
  }

  await index.beginUpdate();

  try {
    for (const entry of legacyEntries) {
      if (!entry.embedding || entry.embedding.length === 0) {
        continue;
      }

      await index.upsertItem({
        id: entry.id,
        vector: entry.embedding,
        metadata: {
          title: entry.title,
          path: entry.path,
          excerpt: entry.excerpt,
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

function toLongTermEntryFromVectraItem(
  settings: AppSettings,
  tier: MemoryTier,
  item: IndexItem<LongTermMemoryMetadata>,
): LongTermMemoryEntry {
  const title = asNonEmptyString(item.metadata?.title);
  const path = asNonEmptyString(item.metadata?.path);
  const excerptFromMetadata = asNonEmptyString(item.metadata?.excerpt);
  const fallbackExcerpt =
    excerptFromMetadata.length > 0 || path.length === 0
      ? ""
      : trimToLength(
          loadFragmentContent(settings, tier, path),
          getTierSettings(settings, tier).maxFragmentChars,
        );

  return {
    id: item.id,
    title: title.length > 0 ? title : basename(path, ".md"),
    path,
    excerpt: excerptFromMetadata.length > 0 ? excerptFromMetadata : fallbackExcerpt,
    updatedAt: asNonEmptyString(item.metadata?.updatedAt) || new Date().toISOString(),
    accessCount: asNumber(item.metadata?.accessCount, 0),
    lastAccessedAt: asNonEmptyString(item.metadata?.lastAccessedAt),
  };
}

function toRankedLongTermEntry(
  settings: AppSettings,
  tier: MemoryTier,
  result: QueryResult<LongTermMemoryMetadata>,
  scoreSource: RankedLongTermEntry["scoreSource"],
): RankedLongTermEntry {
  return {
    ...toLongTermEntryFromVectraItem(settings, tier, result.item),
    score: result.score,
    scoreSource,
    accessCount: asNumber(result.item.metadata?.accessCount, 0),
    lastAccessedAt: asNonEmptyString(result.item.metadata?.lastAccessedAt),
  };
}

function loadFragmentContent(settings: AppSettings, tier: MemoryTier, relativePath: string): string {
  const absolutePath = resolve(getTierSettings(settings, tier).dir, relativePath);
  if (!existsSync(absolutePath)) {
    return "";
  }

  const stats = statSync(absolutePath);
  if (!stats.isFile()) {
    return "";
  }

  return readFileSync(absolutePath, "utf8").trim();
}

function scanRecentFragments(settings: AppSettings, tier: MemoryTier): RankedLongTermEntry[] {
  ensureTierStorage(settings, tier);
  const entries: RankedLongTermEntry[] = [];
  const tierSettings = getTierSettings(settings, tier);
  const stack = [tierSettings.dir];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    if (!currentPath) {
      continue;
    }

    for (const fileName of readdirSync(currentPath).sort((left, right) => left.localeCompare(right))) {
      const absolutePath = resolve(currentPath, fileName);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (
        absolutePath === tierSettings.indexPath ||
        extname(absolutePath) !== ".md"
      ) {
        continue;
      }

      const content = readFileSync(absolutePath, "utf8").trim();
      if (content.length === 0) {
        continue;
      }

      const relativePath = getTierRelativePath(settings, tier, absolutePath);
      entries.push({
        id: basename(relativePath, ".md"),
        title: basename(relativePath, ".md"),
        path: relativePath,
        excerpt: trimToLength(content, tierSettings.maxFragmentChars),
        updatedAt: stats.mtime.toISOString(),
        score: 1,
        scoreSource: "recent",
        accessCount: 0,
        lastAccessedAt: "",
      });
    }
  }

  return entries;
}

interface LongTermFragmentMatch {
  entry: LongTermMemoryEntry;
  titleScore: number;
  excerptScore: number;
  combinedScore: number;
}

interface QueryTierEntriesResult {
  entries: RankedLongTermEntry[];
  retrievalMode: TierMemoryDebugInfo["retrievalMode"];
  embeddingAttempted: boolean;
  embeddingSucceeded: boolean;
}

function findBestExistingFragmentMatch(
  existingEntries: LongTermMemoryEntry[],
  title: string,
  excerpt: string,
): LongTermFragmentMatch | null {
  const normalizedTitle = normalizedMemoryText(normalizeTitle(title));
  const normalizedExcerpt = normalizedMemoryText(excerpt);
  let bestMatch: LongTermFragmentMatch | null = null;

  for (const entry of existingEntries) {
    const titleScore = lexicalScore(normalizedTitle, normalizedMemoryText(entry.title));
    const excerptScore = lexicalScore(normalizedExcerpt, normalizedMemoryText(entry.excerpt));
    const combinedScore = titleScore * 0.45 + excerptScore * 0.55;

    if (titleScore < 0.65 && excerptScore < 0.8) {
      continue;
    }

    if (
      !bestMatch ||
      combinedScore > bestMatch.combinedScore ||
      (combinedScore === bestMatch.combinedScore && entry.updatedAt > bestMatch.entry.updatedAt)
    ) {
      bestMatch = {
        entry,
        titleScore,
        excerptScore,
        combinedScore,
      };
    }
  }

  return bestMatch;
}

async function queryTierEntries(
  settings: AppSettings,
  tier: MemoryTier,
  query: string,
  debugCollector?: DebugCollector,
): Promise<QueryTierEntriesResult> {
  const trimmedQuery = query.trim();
  const tierSettings = getTierSettings(settings, tier);
  if (trimmedQuery.length === 0) {
    return {
      entries: scanRecentFragments(settings, tier)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, tierSettings.topK),
      retrievalMode: "recent",
      embeddingAttempted: false,
      embeddingSucceeded: false,
    };
  }

  const index = await ensureVectorIndex(settings, tier);
  await migrateLegacyLongTermIndexIfNeeded(settings, tier, index);
  const existingItems = await index.listItems();
  if (existingItems.length === 0) {
    return {
      entries: scanRecentFragments(settings, tier).slice(0, tierSettings.topK),
      retrievalMode: "recent",
      embeddingAttempted: false,
      embeddingSucceeded: false,
    };
  }

  try {
    const queryEmbedding = await createEmbedding(settings, trimmedQuery, debugCollector, {
      purpose: "memory_query",
      scope: `${tier}:${trimmedQuery}`,
      tier,
    });
    const results = await index.queryItems(queryEmbedding, trimmedQuery, tierSettings.topK);

    return {
      entries: dedupeRankedEntries(
        results
          .map((result) => toRankedLongTermEntry(settings, tier, result, "embedding"))
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }

            return right.updatedAt.localeCompare(left.updatedAt);
          }),
      ),
      retrievalMode: "embedding",
      embeddingAttempted: true,
      embeddingSucceeded: true,
    };
  } catch {
    return {
      entries: dedupeRankedEntries(
        existingItems
          .map((item) => ({
            ...toLongTermEntryFromVectraItem(settings, tier, item),
            score: lexicalScore(
              trimmedQuery,
              `${asNonEmptyString(item.metadata?.title)} ${asNonEmptyString(item.metadata?.excerpt)}`,
            ),
            scoreSource: "lexical" as const,
          }))
          .filter((entry) => entry.score >= 0)
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }

            return right.updatedAt.localeCompare(left.updatedAt);
          })
          .slice(0, tierSettings.topK),
      ),
      retrievalMode: "lexical",
      embeddingAttempted: true,
      embeddingSucceeded: false,
    };
  }
}

function dedupeRankedEntries(entries: RankedLongTermEntry[]): RankedLongTermEntry[] {
  const kept: RankedLongTermEntry[] = [];

  for (const candidate of entries) {
    const normalizedTitle = normalizedMemoryText(candidate.title);
    const normalizedExcerpt = normalizedMemoryText(candidate.excerpt);
    const isDuplicate = kept.some((existing) => {
      const titleScore = lexicalScore(normalizedTitle, normalizedMemoryText(existing.title));
      const excerptScore = lexicalScore(normalizedExcerpt, normalizedMemoryText(existing.excerpt));
      return titleScore >= 0.8 || excerptScore >= 0.88 || (titleScore >= 0.65 && excerptScore >= 0.72);
    });

    if (!isDuplicate) {
      kept.push(candidate);
    }
  }

  return kept;
}

async function recordMidTermAccess(
  settings: AppSettings,
  entries: RankedLongTermEntry[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const index = await ensureVectorIndex(settings, "midTerm");
  await index.beginUpdate();

  try {
    const accessedAt = new Date().toISOString();

    for (const entry of entries) {
      const item = await index.getItem(entry.id);
      if (!item) {
        continue;
      }

      await index.upsertItem({
        id: item.id,
        vector: item.vector,
        metadata: {
          ...item.metadata,
          accessCount: asNumber(item.metadata?.accessCount, 0) + 1,
          lastAccessedAt: accessedAt,
        },
      });
    }

    await index.endUpdate();
  } catch (error) {
    index.cancelUpdate();
    throw error;
  }
}

export function appendShortTermMemory(
  settings: AppSettings,
  entry: Omit<ShortTermConversationEntry, "createdAt"> & { createdAt?: string },
): void {
  const content = trimToLength(entry.content, SHORT_TERM_ENTRY_MAX_CHARS);
  if (content.length === 0) {
    return;
  }

  const memoryFile = loadShortTermMemoryFile(settings);
  const sanitizedMetadata = entry.metadata ? sanitizeShortTermMetadata(entry.metadata) : undefined;
  const nextEntry: ShortTermMemoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: entry.role,
    content,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    ...(entry.kind ? { kind: entry.kind } : {}),
    ...(entry.includeInPrompt !== undefined ? { includeInPrompt: entry.includeInPrompt } : {}),
    ...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {}),
  };

  memoryFile.entries = pruneShortTermEntries(settings, [...memoryFile.entries, nextEntry]);
  saveShortTermMemoryFile(settings, memoryFile);
}

export function clearShortTermMemory(settings: AppSettings): void {
  saveShortTermMemoryFile(settings, EMPTY_SHORT_TERM_MEMORY);
}

export function loadShortTermMemorySnapshot(
  settings: AppSettings,
  conversationEntries: ShortTermConversationEntry[],
): string {
  return loadShortTermMemorySnapshotWithDebug(settings, conversationEntries).text;
}

export function loadShortTermMemorySnapshotWithDebug(
  settings: AppSettings,
  conversationEntries: ShortTermConversationEntry[],
): ShortTermMemorySnapshotResult {
  const blocks: string[] = [];
  const sources: ShortTermMemorySourceDebugInfo[] = [];

  if (settings.memory.shortTerm.mode === "buffer" || settings.memory.shortTerm.mode === "hybrid") {
    const bufferEntries = loadShortTermMemoryFile(settings).entries;
    const bufferBlock = formatShortTermEntries(bufferEntries, settings.memory.shortTerm.maxTotalChars);
    if (bufferBlock.length > 0) {
      const renderedBlock = `Kurzzeitgedaechtnis (buffer):\n${bufferBlock}`;
      blocks.push(renderedBlock);
      sources.push({
        source: "buffer",
        text: renderedBlock,
      });
    }
  }

  if (
    settings.memory.shortTerm.mode === "conversation" ||
    settings.memory.shortTerm.mode === "hybrid"
  ) {
    const conversationBlock = formatShortTermEntries(
      conversationEntries,
      settings.memory.shortTerm.maxTotalChars,
    );
    if (conversationBlock.length > 0) {
      const renderedBlock = `Kurzzeitgedaechtnis (conversation):\n${conversationBlock}`;
      blocks.push(renderedBlock);
      sources.push({
        source: "conversation",
        text: renderedBlock,
      });
    }
  }

  const dedupedBlocks = dedupeShortTermBlocks(blocks);
  if (dedupedBlocks.length === 0) {
    return {
      text: "",
      debug: {
        mode: settings.memory.shortTerm.mode,
        sources,
        text: "",
      },
    };
  }

  const text = dedupedBlocks.join("\n\n").slice(0, settings.memory.shortTerm.maxTotalChars);
  return {
    text,
    debug: {
      mode: settings.memory.shortTerm.mode,
      sources,
      text,
    },
  };
}

export async function loadLongTermMemoryContext(
  settings: AppSettings,
  query: string,
): Promise<string> {
  return (await loadLongTermMemoryContextWithDebug(settings, query)).text;
}

export async function loadLongTermMemoryContextWithDebug(
  settings: AppSettings,
  query: string,
  debugCollector?: DebugCollector,
): Promise<TierMemoryContextResult> {
  const queryResult = await queryTierEntries(settings, "longTerm", query, debugCollector);
  const rankedEntries = queryResult.entries;
  const usedEntries: MemoryDebugFragment[] = [];
  if (rankedEntries.length === 0) {
    return {
      text: "",
      debug: {
        tier: "longTerm",
        query,
        retrievalMode: queryResult.retrievalMode,
        embeddingAttempted: queryResult.embeddingAttempted,
        embeddingSucceeded: queryResult.embeddingSucceeded,
        usedEntries: [],
        text: "",
      },
    };
  }

  const memoryEntries: string[] = [];
  let usedChars = 0;

  for (const entry of rankedEntries) {
    const content = loadFragmentContent(settings, "longTerm", entry.path);
    if (content.length === 0) {
      continue;
    }

    if (!isUsefulLongTermFragment(entry.title, content)) {
      continue;
    }

    const remainingChars = settings.memory.longTerm.maxTotalChars - usedChars;
    if (remainingChars <= 0) {
      break;
    }

    const finalContent = content.slice(
      0,
      Math.min(settings.memory.longTerm.maxFragmentChars, remainingChars),
    );
    if (finalContent.length === 0) {
      continue;
    }

    memoryEntries.push(
      `## ${entry.title}\n[id:${entry.id} score:${entry.score.toFixed(4)} source:${entry.scoreSource}]\n${finalContent}`,
    );
    usedChars += finalContent.length;
    usedEntries.push({
      id: entry.id,
      title: entry.title,
      path: entry.path,
      score: entry.score,
      scoreSource: entry.scoreSource,
    });
  }

  if (memoryEntries.length === 0) {
    return {
      text: "",
      debug: {
        tier: "longTerm",
        query,
        retrievalMode: queryResult.retrievalMode,
        embeddingAttempted: queryResult.embeddingAttempted,
        embeddingSucceeded: queryResult.embeddingSucceeded,
        usedEntries: [],
        text: "",
      },
    };
  }

  const text = [
    "Long-Term-Memory. Das sind die relevantesten kompakten Wissensfragmente fuer diese Anfrage.",
    ...memoryEntries,
  ].join("\n\n");
  return {
    text,
    debug: {
      tier: "longTerm",
      query,
      retrievalMode: queryResult.retrievalMode,
      embeddingAttempted: queryResult.embeddingAttempted,
      embeddingSucceeded: queryResult.embeddingSucceeded,
      usedEntries,
      text,
    },
  };
}

export async function loadMidTermMemoryContext(
  settings: AppSettings,
  query: string,
): Promise<string> {
  return (await loadMidTermMemoryContextWithDebug(settings, query)).text;
}

export async function loadMidTermMemoryContextWithDebug(
  settings: AppSettings,
  query: string,
  debugCollector?: DebugCollector,
): Promise<TierMemoryContextResult> {
  const queryResult = await queryTierEntries(settings, "midTerm", query, debugCollector);
  const rankedEntries = queryResult.entries;
  if (rankedEntries.length === 0) {
    return {
      text: "",
      debug: {
        tier: "midTerm",
        query,
        retrievalMode: queryResult.retrievalMode,
        embeddingAttempted: queryResult.embeddingAttempted,
        embeddingSucceeded: queryResult.embeddingSucceeded,
        usedEntries: [],
        text: "",
      },
    };
  }

  await recordMidTermAccess(settings, rankedEntries);

  const memoryEntries: string[] = [];
  const usedEntries: MemoryDebugFragment[] = [];
  let usedChars = 0;

  for (const entry of rankedEntries) {
    const content = loadFragmentContent(settings, "midTerm", entry.path);
    if (content.length === 0) {
      continue;
    }

    const remainingChars = settings.memory.midTerm.maxTotalChars - usedChars;
    if (remainingChars <= 0) {
      break;
    }

    const finalContent = content.slice(
      0,
      Math.min(settings.memory.midTerm.maxFragmentChars, remainingChars),
    );
    if (finalContent.length === 0) {
      continue;
    }

    memoryEntries.push(
      `## ${entry.title}\n[id:${entry.id} score:${entry.score.toFixed(4)} source:${entry.scoreSource}]\n${finalContent}`,
    );
    usedChars += finalContent.length;
    usedEntries.push({
      id: entry.id,
      title: entry.title,
      path: entry.path,
      score: entry.score,
      scoreSource: entry.scoreSource,
    });
  }

  if (memoryEntries.length === 0) {
    return {
      text: "",
      debug: {
        tier: "midTerm",
        query,
        retrievalMode: queryResult.retrievalMode,
        embeddingAttempted: queryResult.embeddingAttempted,
        embeddingSucceeded: queryResult.embeddingSucceeded,
        usedEntries: [],
        text: "",
      },
    };
  }

  const text = [
    "Mid-Term-Memory. Das sind relevante, verdichtete Arbeits-Erinnerungen mit laufender Relevanzpruefung.",
    ...memoryEntries,
  ].join("\n\n");
  return {
    text,
    debug: {
      tier: "midTerm",
      query,
      retrievalMode: queryResult.retrievalMode,
      embeddingAttempted: queryResult.embeddingAttempted,
      embeddingSucceeded: queryResult.embeddingSucceeded,
      usedEntries,
      text,
    },
  };
}

async function pruneMidTermMemory(settings: AppSettings): Promise<void> {
  const index = await ensureVectorIndex(settings, "midTerm");
  const items = await index.listItems();
  if (items.length <= settings.memory.midTerm.maxEntries) {
    return;
  }

  const rankedItems = items
    .map((item) => ({
      item,
      accessCount: asNumber(item.metadata?.accessCount, 0),
      lastAccessedAt: asNonEmptyString(item.metadata?.lastAccessedAt),
      updatedAt: asNonEmptyString(item.metadata?.updatedAt),
    }))
    .sort((left, right) => {
      if (right.accessCount !== left.accessCount) {
        return right.accessCount - left.accessCount;
      }

      const leftFreshness = left.lastAccessedAt || left.updatedAt;
      const rightFreshness = right.lastAccessedAt || right.updatedAt;
      return rightFreshness.localeCompare(leftFreshness);
    });

  const itemsToDelete = rankedItems.slice(settings.memory.midTerm.maxEntries);
  if (itemsToDelete.length === 0) {
    return;
  }

  await index.beginUpdate();

  try {
    for (const candidate of itemsToDelete) {
      const relativePath = asNonEmptyString(candidate.item.metadata?.path);
      if (relativePath.length > 0) {
        rmSync(resolve(settings.memory.midTerm.dir, relativePath), { force: true });
      }

      await index.deleteItem(candidate.item.id);
    }

    await index.endUpdate();
  } catch (error) {
    index.cancelUpdate();
    throw error;
  }
}

async function storeTierFragments(
  settings: AppSettings,
  tier: MemoryTier,
  fragments: LongTermFragmentDraft[],
  debugCollector?: DebugCollector,
): Promise<StoredLongTermFragment[]> {
  const tierSettings = getTierSettings(settings, tier);
  ensureTierStorage(settings, tier);
  const index = await ensureVectorIndex(settings, tier);
  await migrateLegacyLongTermIndexIfNeeded(settings, tier, index);
  const storedFragments: StoredLongTermFragment[] = [];
  const existingEntries = (await index.listItems()).map((item) =>
    toLongTermEntryFromVectraItem(settings, tier, item),
  );

  const preparedFragments = dedupeFragmentDrafts(fragments)
    .map((fragment) => ({
      ...fragment,
      title: normalizeTitle(fragment.title),
      content: trimToLength(fragment.content, tierSettings.maxFragmentChars),
    }))
    .filter((fragment) => fragment.title.length > 0 && fragment.content.length > 0)
    .filter((fragment) => tier !== "longTerm" || isUsefulLongTermFragment(fragment.title, fragment.content))
    .sort((left, right) => scoreFragmentUtility(right.title, right.content) - scoreFragmentUtility(left.title, left.content))
    .slice(0, tierSettings.maxFragmentsPerSleep);

  await index.beginUpdate();

  try {
    for (const fragment of preparedFragments) {
      const { title, content } = fragment;
      const match = findBestExistingFragmentMatch(existingEntries, title, content);
      const relativePath = match ? match.entry.path : buildFragmentRelativePath(title);
      const resolvedRoot = resolve(tierSettings.dir);
      const normalizedRelativePath = normalizeRelativeLongTermPath(resolvedRoot, relativePath);
      const finalAbsolutePath = resolve(resolvedRoot, normalizedRelativePath);

      if (
        finalAbsolutePath !== resolvedRoot &&
        !finalAbsolutePath.startsWith(`${resolvedRoot}${sep}`)
      ) {
        throw new Error(`Memory-Pfad fuer ${tier} muss innerhalb des konfigurierten Verzeichnisses liegen.`);
      }

      ensureDirectory(dirname(finalAbsolutePath));
      writeFileSync(finalAbsolutePath, `# ${title}\n\n${content}\n`, "utf8");

      let embedding: number[] | null = null;
      let embeddingUsed = false;

      try {
        embedding = await createEmbedding(settings, buildEmbeddingText(title, content), debugCollector, {
          purpose: "memory_store_sleep",
          scope: `${tier}:${title}`,
          tier,
        });
        embeddingUsed = true;
      } catch {
        embedding = null;
      }

      if (!embedding || embedding.length === 0) {
        continue;
      }

      const nextTimestamp = new Date().toISOString();
      const entry: LongTermMemoryEntry = {
        id: match ? match.entry.id : basename(relativePath, ".md"),
        title,
        path: relativePath,
        excerpt: content,
        updatedAt: nextTimestamp,
      };

      await index.upsertItem({
        id: entry.id,
        vector: embedding,
        metadata: {
          title,
          path: relativePath,
          excerpt: content,
          updatedAt: nextTimestamp,
          accessCount: match ? existingEntries.find((candidate) => candidate.id === entry.id)?.accessCount ?? 0 : 0,
          lastAccessedAt: match ? existingEntries.find((candidate) => candidate.id === entry.id)?.lastAccessedAt ?? "" : "",
        },
      });

      if (match) {
        const existingIndex = existingEntries.findIndex((candidate) => candidate.id === match.entry.id);
        if (existingIndex >= 0) {
          existingEntries[existingIndex] = entry;
        }
      } else {
        existingEntries.push(entry);
      }

      storedFragments.push({
        id: entry.id,
        title,
        path: finalAbsolutePath,
        content,
        embeddingUsed,
        action: match ? "updated" : "created",
      });
    }

    await index.endUpdate();
  } catch (error) {
    index.cancelUpdate();
    throw error;
  }

  if (tier === "midTerm") {
    await pruneMidTermMemory(settings);
  }

  return storedFragments;
}

export async function storeMidTermMemoryFragments(
  settings: AppSettings,
  fragments: LongTermFragmentDraft[],
  debugCollector?: DebugCollector,
): Promise<StoredLongTermFragment[]> {
  return storeTierFragments(settings, "midTerm", fragments, debugCollector);
}

export async function storeLongTermMemoryFragments(
  settings: AppSettings,
  fragments: LongTermFragmentDraft[],
  debugCollector?: DebugCollector,
): Promise<StoredLongTermFragment[]> {
  return storeTierFragments(settings, "longTerm", fragments, debugCollector);
}

function clearTierMemory(settings: AppSettings, tier: MemoryTier): void {
  const tierSettings = getTierSettings(settings, tier);
  rmSync(tierSettings.dir, { recursive: true, force: true });
  rmSync(getVectorIndexPath(settings, tier), { recursive: true, force: true });
  rmSync(tierSettings.indexPath, { recursive: true, force: true });
}

export function clearMidTermMemory(settings: AppSettings): void {
  clearTierMemory(settings, "midTerm");
}

export function clearLongTermMemory(settings: AppSettings): void {
  clearTierMemory(settings, "longTerm");
}

export function resetAllMemory(settings: AppSettings): void {
  clearShortTermMemory(settings);
  clearMidTermMemory(settings);
  clearLongTermMemory(settings);
}
