import type { DebugCollector } from "../../debug";
import {
  appendShortTermMemory,
  clearShortTermMemory,
  loadLongTermMemoryContextWithDebug,
  loadMidTermMemoryContextWithDebug,
  loadShortTermMemorySnapshot,
  loadShortTermMemorySnapshotWithDebug,
  resetAllMemory,
  storeLongTermMemoryFragments,
  storeMidTermMemoryFragments,
  type LongTermFragmentDraft,
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

  resetAllMemory(settings: AppSettings): void {
    resetAllMemory(settings);
  }
}

