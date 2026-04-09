import type {
  LongTermFragmentDraft,
  MemoryFeedbackEntry,
  MemoryDebugFragment,
  MemoryTier,
  PersistedMemoryFragment,
  SleepFeedbackEntry,
  ShortTermConversationEntry,
  ShortTermMemoryDebugInfo,
  ShortTermMemorySnapshotResult,
  ShortTermMemorySourceDebugInfo,
  StoredLongTermFragment,
  TierMemoryContextResult,
  TierMemoryDebugInfo,
  ToolRoutingLearning,
} from "./domain/memoryTypes";
import { ShortTermMemoryService } from "./infrastructure/memory/ShortTermMemoryService";
import { TieredMemoryService } from "./infrastructure/memory/TieredMemoryService";
import type { AppSettings } from "./settings";
import type { DebugCollector } from "./debug";

export type {
  LongTermFragmentDraft,
  MemoryFeedbackEntry,
  MemoryDebugFragment,
  MemoryTier,
  PersistedMemoryFragment,
  SleepFeedbackEntry,
  ShortTermConversationEntry,
  ShortTermMemoryDebugInfo,
  ShortTermMemorySnapshotResult,
  ShortTermMemorySourceDebugInfo,
  StoredLongTermFragment,
  TierMemoryContextResult,
  TierMemoryDebugInfo,
  ToolRoutingLearning,
} from "./domain/memoryTypes";

const shortTermMemoryService = new ShortTermMemoryService();
const tieredMemoryService = new TieredMemoryService();

export function appendShortTermMemory(
  settings: AppSettings,
  entry: Omit<ShortTermConversationEntry, "createdAt"> & { createdAt?: string },
): void {
  shortTermMemoryService.appendShortTermMemory(settings, entry);
}

export function clearShortTermMemory(settings: AppSettings): void {
  shortTermMemoryService.clearShortTermMemory(settings);
}

export function loadSleepFeedback(settings: AppSettings): SleepFeedbackEntry[] {
  return shortTermMemoryService.loadSleepFeedback(settings);
}

export function recordSleepFeedback(settings: AppSettings, entry: SleepFeedbackEntry): void {
  shortTermMemoryService.recordSleepFeedback(settings, entry);
}

export function loadMemoryFeedback(settings: AppSettings): MemoryFeedbackEntry[] {
  return shortTermMemoryService.loadMemoryFeedback(settings);
}

export function recordMemoryFeedback(settings: AppSettings, entry: MemoryFeedbackEntry): void {
  shortTermMemoryService.recordMemoryFeedback(settings, entry);
}

export function loadPersistedShortTermEntries(settings: AppSettings): ShortTermConversationEntry[] {
  return shortTermMemoryService.loadPersistedEntries(settings);
}

export function loadShortTermMemorySnapshot(
  settings: AppSettings,
  conversationEntries: ShortTermConversationEntry[],
): string {
  return shortTermMemoryService.loadShortTermMemorySnapshot(settings, conversationEntries);
}

export function loadShortTermMemorySnapshotWithDebug(
  settings: AppSettings,
  conversationEntries: ShortTermConversationEntry[],
): ShortTermMemorySnapshotResult {
  return shortTermMemoryService.loadShortTermMemorySnapshotWithDebug(settings, conversationEntries);
}

export async function loadLongTermMemoryContext(
  settings: AppSettings,
  query: string,
): Promise<string> {
  return (await tieredMemoryService.loadTierContextWithDebug(settings, "longTerm", query)).text;
}

export async function loadLongTermMemoryContextWithDebug(
  settings: AppSettings,
  query: string,
  debugCollector?: DebugCollector,
): Promise<TierMemoryContextResult> {
  return tieredMemoryService.loadTierContextWithDebug(settings, "longTerm", query, debugCollector);
}

export async function loadMidTermMemoryContext(
  settings: AppSettings,
  query: string,
): Promise<string> {
  return (await tieredMemoryService.loadTierContextWithDebug(settings, "midTerm", query)).text;
}

export async function loadMidTermMemoryContextWithDebug(
  settings: AppSettings,
  query: string,
  debugCollector?: DebugCollector,
): Promise<TierMemoryContextResult> {
  return tieredMemoryService.loadTierContextWithDebug(settings, "midTerm", query, debugCollector);
}

export async function storeMidTermMemoryFragments(
  settings: AppSettings,
  fragments: LongTermFragmentDraft[],
  debugCollector?: DebugCollector,
): Promise<StoredLongTermFragment[]> {
  return tieredMemoryService.storeTierFragments(settings, "midTerm", fragments, debugCollector);
}

export async function storeLongTermMemoryFragments(
  settings: AppSettings,
  fragments: LongTermFragmentDraft[],
  debugCollector?: DebugCollector,
): Promise<StoredLongTermFragment[]> {
  return tieredMemoryService.storeTierFragments(settings, "longTerm", fragments, debugCollector);
}

export async function loadMidTermMemoryFragments(settings: AppSettings): Promise<PersistedMemoryFragment[]> {
  return tieredMemoryService.listTierFragments(settings, "midTerm");
}

export async function loadLongTermMemoryFragments(settings: AppSettings): Promise<PersistedMemoryFragment[]> {
  return tieredMemoryService.listTierFragments(settings, "longTerm");
}

export async function replaceMidTermMemoryFragments(
  settings: AppSettings,
  fragments: LongTermFragmentDraft[],
  debugCollector?: DebugCollector,
): Promise<StoredLongTermFragment[]> {
  return tieredMemoryService.replaceTierFragments(settings, "midTerm", fragments, debugCollector);
}

export async function replaceLongTermMemoryFragments(
  settings: AppSettings,
  fragments: LongTermFragmentDraft[],
  debugCollector?: DebugCollector,
): Promise<StoredLongTermFragment[]> {
  return tieredMemoryService.replaceTierFragments(settings, "longTerm", fragments, debugCollector);
}

export async function replaceProtectedLongTermMemoryFragments(
  settings: AppSettings,
  fragments: LongTermFragmentDraft[],
  debugCollector?: DebugCollector,
): Promise<StoredLongTermFragment[]> {
  return tieredMemoryService.replaceProtectedTierFragments(settings, "longTerm", fragments, debugCollector);
}

export function clearMidTermMemory(settings: AppSettings): void {
  tieredMemoryService.clearTierMemory(settings, "midTerm");
}

export function clearLongTermMemory(settings: AppSettings): void {
  tieredMemoryService.clearTierMemory(settings, "longTerm");
}

export function resetAllMemory(settings: AppSettings): void {
  clearShortTermMemory(settings);
  clearMidTermMemory(settings);
  clearLongTermMemory(settings);
}
