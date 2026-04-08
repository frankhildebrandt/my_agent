import type { IClock, IMemoryRepository } from "../../domain/ports";
import type {
  CreatedScriptInfo,
  MessageSnapshotMetadata,
  PromptDebugSegment,
  PromptSnapshotMetadata,
  SessionUsageTotals,
} from "../../domain/chatTypes";
import type { ChatMessage } from "../../inference";
import type { AppSettings } from "../../settings";
import type { ShortTermConversationEntry } from "../../memory";

export class SessionContext {
  private activeModelAliasValue: string;
  private debugEnabledValue = false;
  private sessionEventsValue: ShortTermConversationEntry[] = [];
  private sessionUsageValue: SessionUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
  private readonly createdScriptsValue = new Map<string, CreatedScriptInfo>();

  constructor(
    private readonly settings: AppSettings,
    private readonly memoryRepository: IMemoryRepository,
    private readonly clock: IClock,
  ) {
    this.activeModelAliasValue = settings.llm.defaultModel;
  }

  get activeModelAlias(): string {
    return this.activeModelAliasValue;
  }

  get debugEnabled(): boolean {
    return this.debugEnabledValue;
  }

  get sessionEvents(): ShortTermConversationEntry[] {
    return [...this.sessionEventsValue];
  }

  get sessionUsage(): SessionUsageTotals {
    return { ...this.sessionUsageValue };
  }

  get createdScripts(): Map<string, CreatedScriptInfo> {
    return this.createdScriptsValue;
  }

  setActiveModel(alias: string): void {
    this.activeModelAliasValue = alias;
  }

  toggleDebug(): boolean {
    this.debugEnabledValue = !this.debugEnabledValue;
    return this.debugEnabledValue;
  }

  reset(): void {
    this.sessionEventsValue = [];
    this.sessionUsageValue = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0,
    };
    this.createdScriptsValue.clear();
    this.memoryRepository.clearShortTermMemory(this.settings);
  }

  clearEvents(): void {
    this.sessionEventsValue = [];
  }

  pushEvent(entry: Omit<ShortTermConversationEntry, "createdAt"> & { createdAt?: string }): void {
    const trimmedContent = entry.content.trim();
    if (trimmedContent.length === 0) {
      return;
    }

    const normalizedEntry: ShortTermConversationEntry = {
      role: entry.role,
      kind: entry.kind ?? "message",
      content: trimmedContent,
      createdAt: entry.createdAt ?? this.clock.nowIso(),
      ...(entry.includeInPrompt !== undefined ? { includeInPrompt: entry.includeInPrompt } : {}),
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };

    this.sessionEventsValue.push(normalizedEntry);
    this.memoryRepository.appendShortTermMemory(this.settings, normalizedEntry);
  }

  recordUsage(usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }): void {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

    if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
      return;
    }

    this.sessionUsageValue.inputTokens += inputTokens;
    this.sessionUsageValue.outputTokens += outputTokens;
    this.sessionUsageValue.totalTokens += totalTokens;
    this.sessionUsageValue.requests += 1;
  }

  snapshotMessages(messages: ChatMessage[]): MessageSnapshotMetadata {
    return {
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    };
  }

  snapshotPromptSegments(promptSegments: PromptDebugSegment[]): PromptSnapshotMetadata {
    return {
      promptSegments: promptSegments.map((segment) => ({
        label: segment.label,
        role: segment.role,
        content: segment.content,
      })),
    };
  }
}
