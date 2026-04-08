import type {
  DebugChatMetadata,
  DebugCollector,
  DebugEmbeddingMetadata,
} from "./debug";
export { InferenceError } from "./infrastructure/inference/InferenceError";
import { InferenceError } from "./infrastructure/inference/InferenceError";
import { OpenAiCompatibleInferenceClient } from "./infrastructure/inference/OpenAiCompatibleInferenceClient";
import type { AppSettings } from "./settings";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface InferenceResult {
  modelAlias: string;
  providerName: string;
  providerModelId: string;
  text: string;
  reasoning: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  requestBody: Record<string, unknown>;
  rawResponse: unknown;
}

export interface ChatCompletionStreamCallbacks {
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}

export type TokenParameterName = "max_tokens" | "max_completion_tokens";

const defaultInferenceClient = new OpenAiCompatibleInferenceClient();

export async function createChatCompletion(
  settings: AppSettings,
  modelAlias: string,
  messages: ChatMessage[],
  debugCollector?: DebugCollector,
  debugMetadata?: DebugChatMetadata,
  streamCallbacks?: ChatCompletionStreamCallbacks,
  externalSignal?: AbortSignal,
): Promise<InferenceResult> {
  return defaultInferenceClient.createChatCompletion(
    settings,
    modelAlias,
    messages,
    debugCollector,
    debugMetadata,
    streamCallbacks,
    externalSignal,
  );
}

export async function createEmbedding(
  settings: AppSettings,
  input: string,
  debugCollector?: DebugCollector,
  debugMetadata?: DebugEmbeddingMetadata,
): Promise<number[]> {
  return defaultInferenceClient.createEmbedding(settings, input, debugCollector, debugMetadata);
}
