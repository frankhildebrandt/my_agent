import type { ChatMessage } from "../inference";
import type {
  LongTermFragmentDraft,
  ShortTermConversationEntry,
  ShortTermMemoryDebugInfo,
  TierMemoryDebugInfo,
} from "../memory";

export interface SleepConsolidationResponse {
  fragments?: LongTermFragmentDraft[];
  midTermFragments: LongTermFragmentDraft[];
  longTermFragments: LongTermFragmentDraft[];
}

export interface ScriptKnowledgeResponse {
  description: string;
  usage: string;
  midTermTitle: string;
  midTermContent: string;
}

export interface CreatedScriptInfo {
  description: string;
  publishedAfterSuccessfulRun: boolean;
}

export interface PromptDebugSegment {
  label: string;
  role: ChatMessage["role"];
  content: string;
}

export interface RequestDebugInfo {
  modelAlias: string;
  providerName: string;
  providerModelId: string;
  promptSegments: PromptDebugSegment[];
  shortTerm: ShortTermMemoryDebugInfo;
  midTerm: TierMemoryDebugInfo;
  longTerm: TierMemoryDebugInfo;
}

export interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

export interface BuildConversationResult {
  messages: ChatMessage[];
  promptSegments: PromptDebugSegment[];
  debug: RequestDebugInfo;
}

export interface MessageSnapshotMetadata {
  messages: Array<{
    role: ChatMessage["role"];
    content: string;
  }>;
}

export interface PromptSnapshotMetadata {
  promptSegments: Array<{
    label: string;
    role: ChatMessage["role"];
    content: string;
  }>;
}

export interface SessionSnapshot {
  events: ShortTermConversationEntry[];
  usage: SessionUsageTotals;
}
