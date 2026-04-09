import type blessed from "blessed";
import type { DebugCollector, DebugSnapshot } from "../debug";
import type {
  AgentExternalEvent,
  AgentExternalRequestState,
  AgentModulePanelState,
  AgentRequestSummary,
  AgentRequestOrigin,
  ExternalAgentRequestCallbacks,
  ExternalAgentRequestInput,
} from "./agentControlTypes";
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
  MemoryFeedbackEntry,
  PersistedMemoryFragment,
  SleepFeedbackEntry,
  ShortTermConversationEntry,
  StoredLongTermFragment,
} from "../memory";
import type {
  AgentModuleCallResponse,
  AgentModuleDiscoveryEntry,
  AgentModulePolicySnapshot,
  AgentModuleRuntimeInfo,
  BootstrapAgentModuleOptions,
  DiscoverAgentModulesOptions,
} from "../modules";
import type { AppSettings } from "../settings";
import type {
  ToolCall,
  ToolExecutionCallbacks,
  ToolExecutionContext,
  ToolResult,
} from "../tools/index";

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
  loadMemoryFeedback(settings: AppSettings): MemoryFeedbackEntry[];
  recordMemoryFeedback(settings: AppSettings, entry: MemoryFeedbackEntry): void;
  loadSleepFeedback(settings: AppSettings): SleepFeedbackEntry[];
  recordSleepFeedback(settings: AppSettings, entry: SleepFeedbackEntry): void;
  loadPersistedShortTermEntries(settings: AppSettings): ShortTermConversationEntry[];
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
  loadMidTermMemoryFragments(settings: AppSettings): Promise<PersistedMemoryFragment[]>;
  loadLongTermMemoryFragments(settings: AppSettings): Promise<PersistedMemoryFragment[]>;
  replaceMidTermMemoryFragments(
    settings: AppSettings,
    fragments: LongTermFragmentDraft[],
    debugCollector?: DebugCollector,
  ): Promise<StoredLongTermFragment[]>;
  replaceLongTermMemoryFragments(
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

export interface IAgentModuleService {
  bootstrap(
    settings: AppSettings,
    moduleName: string,
    options?: BootstrapAgentModuleOptions,
  ): Promise<{
    createdFiles: string[];
    installed: boolean;
    module: AgentModuleDiscoveryEntry;
    started: boolean;
  }>;
  call(
    settings: AppSettings,
    moduleName: string,
    action: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<{
    action: string;
    autoStarted: boolean;
    module: AgentModuleDiscoveryEntry;
    response: AgentModuleCallResponse;
  }>;
  discover(settings: AppSettings, options?: DiscoverAgentModulesOptions): AgentModuleDiscoveryEntry[];
  getPolicySnapshot(settings: AppSettings): AgentModulePolicySnapshot;
  getRuntimeInfos(settings: AppSettings): AgentModuleRuntimeInfo[];
  isEnabled(settings: AppSettings, moduleName: string): boolean;
  listRunningModules(settings: AppSettings): AgentModuleDiscoveryEntry[];
  setEnabled(settings: AppSettings, moduleName: string, enabled: boolean): Promise<AgentModuleDiscoveryEntry>;
  start(settings: AppSettings, moduleName: string): Promise<AgentModuleDiscoveryEntry>;
  stop(settings: AppSettings, moduleName: string): Promise<AgentModuleDiscoveryEntry>;
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
  notifyExternalEvent(event: AgentExternalEvent): void;
  setExternalRequestState(state: AgentExternalRequestState): void;
  removeModulePanel(panelId: string): void;
  upsertModulePanel(panel: AgentModulePanelState): void;
  renderDebugReport(report: string): void;
}

export interface IAgentRequestService {
  abortActiveExecution(): void;
  abortRequest(requestId: string): boolean;
  getExternalRequestState(): AgentExternalRequestState;
  submitExternalRequest(
    input: ExternalAgentRequestInput,
    callbacks: ExternalAgentRequestCallbacks,
  ): AgentRequestSummary;
  submitTuiPrompt(prompt: string): Promise<void>;
}

export interface IToolLoopDependencies {
  settings: AppSettings;
  inferenceClient: IInferenceClient;
  toolExecutor: IToolExecutor;
  memoryRepository: IMemoryRepository;
  scriptRegistryRepository: IScriptRegistryRepository;
}
