import type { DebugCollector } from "../../debug";
import {
  appendShortTermMemory,
  clearShortTermMemory,
  loadLongTermMemoryFragments,
  loadMemoryFeedback,
  loadSleepFeedback,
  loadPersistedShortTermEntries,
  loadMidTermMemoryFragments,
  loadLongTermMemoryContextWithDebug,
  loadMidTermMemoryContextWithDebug,
  loadShortTermMemorySnapshot,
  loadShortTermMemorySnapshotWithDebug,
  recordMemoryFeedback,
  recordSleepFeedback,
  replaceLongTermMemoryFragments,
  replaceMidTermMemoryFragments,
  resetAllMemory,
  storeLongTermMemoryFragments,
  storeMidTermMemoryFragments,
  type LongTermFragmentDraft,
  type MemoryFeedbackEntry,
  type PersistedMemoryFragment,
  type SleepFeedbackEntry,
  type ShortTermConversationEntry,
  type StoredLongTermFragment,
} from "../../memory";
import type { IMemoryRepository } from "../../domain/ports";
import type { AppSettings } from "../../settings";

export class MemoryRepository implements IMemoryRepository {
  appendShortTermMemory(settings: AppSettings, entry: ShortTermConversationEntry): void {
    appendShortTermMemory(settings, entry);
  }

  clearShortTermMemory(settings: AppSettings): void {
    clearShortTermMemory(settings);
  }

  loadMemoryFeedback(settings: AppSettings): MemoryFeedbackEntry[] {
    return loadMemoryFeedback(settings);
  }

  recordMemoryFeedback(settings: AppSettings, entry: MemoryFeedbackEntry): void {
    recordMemoryFeedback(settings, entry);
  }

  loadSleepFeedback(settings: AppSettings): SleepFeedbackEntry[] {
    return loadSleepFeedback(settings);
  }

  recordSleepFeedback(settings: AppSettings, entry: SleepFeedbackEntry): void {
    recordSleepFeedback(settings, entry);
  }

  loadPersistedShortTermEntries(settings: AppSettings): ShortTermConversationEntry[] {
    return loadPersistedShortTermEntries(settings);
  }

  loadShortTermMemorySnapshot(settings: AppSettings, entries: ShortTermConversationEntry[]): string {
    return loadShortTermMemorySnapshot(settings, entries);
  }

  loadShortTermMemorySnapshotWithDebug(settings: AppSettings, entries: ShortTermConversationEntry[]) {
    return loadShortTermMemorySnapshotWithDebug(settings, entries);
  }

  loadLongTermMemoryContextWithDebug(
    settings: AppSettings,
    query: string,
    debugCollector?: DebugCollector,
  ) {
    return loadLongTermMemoryContextWithDebug(settings, query, debugCollector);
  }

  loadMidTermMemoryContextWithDebug(
    settings: AppSettings,
    query: string,
    debugCollector?: DebugCollector,
  ) {
    return loadMidTermMemoryContextWithDebug(settings, query, debugCollector);
  }

  storeMidTermMemoryFragments(
    settings: AppSettings,
    fragments: LongTermFragmentDraft[],
    debugCollector?: DebugCollector,
  ): Promise<StoredLongTermFragment[]> {
    return storeMidTermMemoryFragments(settings, fragments, debugCollector);
  }

  storeLongTermMemoryFragments(
    settings: AppSettings,
    fragments: LongTermFragmentDraft[],
    debugCollector?: DebugCollector,
  ): Promise<StoredLongTermFragment[]> {
    return storeLongTermMemoryFragments(settings, fragments, debugCollector);
  }

  loadMidTermMemoryFragments(settings: AppSettings): Promise<PersistedMemoryFragment[]> {
    return loadMidTermMemoryFragments(settings);
  }

  loadLongTermMemoryFragments(settings: AppSettings): Promise<PersistedMemoryFragment[]> {
    return loadLongTermMemoryFragments(settings);
  }

  replaceMidTermMemoryFragments(
    settings: AppSettings,
    fragments: LongTermFragmentDraft[],
    debugCollector?: DebugCollector,
  ): Promise<StoredLongTermFragment[]> {
    return replaceMidTermMemoryFragments(settings, fragments, debugCollector);
  }

  replaceLongTermMemoryFragments(
    settings: AppSettings,
    fragments: LongTermFragmentDraft[],
    debugCollector?: DebugCollector,
  ): Promise<StoredLongTermFragment[]> {
    return replaceLongTermMemoryFragments(settings, fragments, debugCollector);
  }

  resetAllMemory(settings: AppSettings): void {
    resetAllMemory(settings);
  }
}
