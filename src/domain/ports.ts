import type blessed from "blessed";
import type { DebugCollector, DebugSnapshot } from "../debug";
import type {
  BuildConversationResult,
  CreatedScriptInfo,
  PromptDebugSegment,
  RequestDebugInfo,
  ScriptKnowledgeResponse,
  SessionUsageTotals,
  SleepConsolidationResponse,
} from "./chatTypes";
import type {
  ChatCompletionStreamCallbacks,
  ChatMessage,
  InferenceResult,
} from "../inference";
import type {
  LongTermFragmentDraft,
  ShortTermConversationEntry,
  StoredLongTermFragment,
} from "../memory";
import type { AppSettings } from "../settings";
import type {
  ToolCall,
  ToolExecutionCallbacks,
  ToolExecutionContext,
  ToolResult,
} from "../tools";

export type HistoryTone = "default" | "reasoning";
export type StatusVariant = "idle" | "request" | "tool" | "error";

export interface IClock {
  now(): Date;
  nowIso(): string;
  localeTime(): string;
}

export interface IEditorLauncher {
  open(filePath: string, settings: AppSettings): Promise<void>;
}

export interface ISettingsRepository {
  load(): AppSettings;
}

export interface IInferenceClient {
  createChatCompletion(
    settings: AppSettings,
    modelAlias: string,
    messages: ChatMessage[],
    debugCollector?: DebugCollector,
    debugMetadata?: { purpose: string; scope: string },
    streamCallbacks?: ChatCompletionStreamCallbacks,
    externalSignal?: AbortSignal,
  ): Promise<InferenceResult>;
}

export interface IEmbeddingClient {
  createEmbedding(
    settings: AppSettings,
    input: string,
    debugCollector?: DebugCollector,
    debugMetadata?: { purpose: string; scope: string; tier?: "shortTerm" | "midTerm" | "longTerm" | "scriptRegistry" },
  ): Promise<number[]>;
}

export interface IMemoryRepository {
  appendShortTermMemory(settings: AppSettings, entry: ShortTermConversationEntry): void;
  clearShortTermMemory(settings: AppSettings): void;
  loadShortTermMemorySnapshot(settings: AppSettings, entries: ShortTermConversationEntry[]): string;
  loadShortTermMemorySnapshotWithDebug(
    settings: AppSettings,
    entries: ShortTermConversationEntry[],
  ): { text: string; debug: BuildConversationResult["debug"]["shortTerm"] };
  loadLongTermMemoryContextWithDebug(
    settings: AppSettings,
    query: string,
    debugCollector?: DebugCollector,
  ): Promise<{ text: string; debug: BuildConversationResult["debug"]["longTerm"] }>;
  loadMidTermMemoryContextWithDebug(
    settings: AppSettings,
    query: string,
    debugCollector?: DebugCollector,
  ): Promise<{ text: string; debug: BuildConversationResult["debug"]["midTerm"] }>;
  storeMidTermMemoryFragments(
    settings: AppSettings,
    fragments: LongTermFragmentDraft[],
    debugCollector?: DebugCollector,
  ): Promise<StoredLongTermFragment[]>;
  storeLongTermMemoryFragments(
    settings: AppSettings,
    fragments: LongTermFragmentDraft[],
    debugCollector?: DebugCollector,
  ): Promise<StoredLongTermFragment[]>;
  resetAllMemory(settings: AppSettings): void;
}

export interface IScriptRegistryRepository {
  publish(
    settings: AppSettings,
    absoluteScriptPath: string,
    description: string,
    usage: string,
    debugCollector?: DebugCollector,
  ): Promise<{ embeddingUsed: boolean }>;
}

export interface IToolExecutor {
  execute(
    settings: AppSettings,
    toolCall: ToolCall,
    debugCollector?: DebugCollector,
    callbacks?: ToolExecutionCallbacks,
    context?: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export interface IChatView {
  appendMessage(prefix: string, message: string, tone?: HistoryTone): number;
  updateMessage(
    index: number,
    patch: Partial<{
      prefix: string;
      message: string;
      tone: HistoryTone;
    }>,
  ): void;
  appendToMessage(index: number, chunk: string): void;
  setTransientStatus(message: string, variant: StatusVariant): void;
  clearTransientStatus(): void;
  renderDebugReport(report: string): void;
}

export interface IToolLoopDependencies {
  settings: AppSettings;
  inferenceClient: IInferenceClient;
  toolExecutor: IToolExecutor;
  memoryRepository: IMemoryRepository;
  scriptRegistryRepository: IScriptRegistryRepository;
}
