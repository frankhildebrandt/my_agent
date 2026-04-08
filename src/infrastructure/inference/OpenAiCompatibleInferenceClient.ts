import type {
  DebugChatMetadata,
  DebugCollector,
  DebugEmbeddingMetadata,
  EmbeddingDebugEvent,
} from "../../debug";
import type {
  ChatCompletionStreamCallbacks,
  ChatMessage,
  InferenceResult,
  TokenParameterName,
} from "../../inference";
import type { IEmbeddingClient, IInferenceClient } from "../../domain/ports";
import type { AppSettings, ProviderConfig } from "../../settings";
import { ProviderCatalog } from "./ProviderCatalog";
import { RequestBodyFactory } from "./RequestBodyFactory";
import { InferenceError } from "./InferenceError";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface ChatCompletionStreamResponse {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface EmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
  error?: {
    message?: string;
  };
}

function extractTextFragment(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .filter((part): part is { text?: string } => typeof part === "object" && part !== null)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
  }

  return "";
}

function extractText(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .filter((part) => typeof part.text === "string" && part.text.trim().length > 0)
      .map((part) => part.text?.trim() ?? "")
      .join("\n")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  throw new InferenceError("Antwort enthielt keinen lesbaren Text.");
}

function extractReasoning(response: ChatCompletionResponse): string {
  const message = response.choices?.[0]?.message;
  return extractTextFragment(message?.reasoning_content) || extractTextFragment(message?.reasoning);
}

function extractUsage(response: ChatCompletionResponse): InferenceResult["usage"] {
  const promptTokens = response.usage?.prompt_tokens;
  const completionTokens = response.usage?.completion_tokens;
  const totalTokens = response.usage?.total_tokens;

  return {
    inputTokens: typeof promptTokens === "number" ? promptTokens : null,
    outputTokens: typeof completionTokens === "number" ? completionTokens : null,
    totalTokens: typeof totalTokens === "number" ? totalTokens : null,
  };
}

function shouldRetryWithMaxCompletionTokens(
  response: Response,
  payload: ChatCompletionResponse,
  attemptedTokenParameter: TokenParameterName,
): boolean {
  const message = payload.error?.message ?? "";

  return (
    response.status === 400 &&
    attemptedTokenParameter === "max_tokens" &&
    message.includes("max_tokens") &&
    message.includes("max_completion_tokens")
  );
}

function buildEmbeddingDebugEvent(
  base: Omit<EmbeddingDebugEvent, "tier"> & { tier?: EmbeddingDebugEvent["tier"] },
): EmbeddingDebugEvent {
  if (base.tier === undefined) {
    const { tier: _tier, ...event } = base;
    return event;
  }

  return {
    ...base,
    tier: base.tier,
  };
}

async function sendChatCompletionRequest(
  providerConfig: ProviderConfig,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${providerConfig.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...providerConfig.defaultHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function readChatCompletionStream(
  response: Response,
  callbacks?: ChatCompletionStreamCallbacks,
): Promise<{
  text: string;
  reasoning: string;
  usage: InferenceResult["usage"];
  rawChunks: ChatCompletionStreamResponse[];
}> {
  if (!response.body) {
    throw new InferenceError("Streaming-Antwort enthielt keinen Body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  let usage: InferenceResult["usage"] = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
  const rawChunks: ChatCompletionStreamResponse[] = [];

  const handleEvent = (rawEvent: string): void => {
    const dataLines = rawEvent
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) {
      return;
    }

    const payloadText = dataLines.join("\n");
    if (payloadText === "[DONE]") {
      return;
    }

    const payload = JSON.parse(payloadText) as ChatCompletionStreamResponse;
    rawChunks.push(payload);

    const delta = payload.choices?.[0]?.delta;
    const textDelta = extractTextFragment(delta?.content);
    const reasoningDelta =
      extractTextFragment(delta?.reasoning_content) || extractTextFragment(delta?.reasoning);

    if (textDelta.length > 0) {
      text += textDelta;
      callbacks?.onTextDelta?.(textDelta);
    }

    if (reasoningDelta.length > 0) {
      reasoning += reasoningDelta;
      callbacks?.onReasoningDelta?.(reasoningDelta);
    }

    if (payload.usage) {
      usage = {
        inputTokens:
          typeof payload.usage.prompt_tokens === "number" ? payload.usage.prompt_tokens : null,
        outputTokens:
          typeof payload.usage.completion_tokens === "number"
            ? payload.usage.completion_tokens
            : null,
        totalTokens:
          typeof payload.usage.total_tokens === "number" ? payload.usage.total_tokens : null,
      };
    }

    if (payload.error?.message) {
      throw new InferenceError(payload.error.message);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex).trim();
        buffer = buffer.slice(separatorIndex + 2);
        if (rawEvent.length > 0) {
          handleEvent(rawEvent);
        }
        separatorIndex = buffer.indexOf("\n\n");
      }

      if (done) {
        const trailingEvent = buffer.trim();
        if (trailingEvent.length > 0) {
          handleEvent(trailingEvent);
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: text.trim(),
    reasoning: reasoning.trim(),
    usage,
    rawChunks,
  };
}

export class OpenAiCompatibleInferenceClient implements IInferenceClient, IEmbeddingClient {
  constructor(
    private readonly providerCatalog = new ProviderCatalog(),
    private readonly requestBodyFactory = new RequestBodyFactory(),
  ) {}

  async createChatCompletion(
    settings: AppSettings,
    modelAlias: string,
    messages: ChatMessage[],
    debugCollector?: DebugCollector,
    debugMetadata?: DebugChatMetadata,
    streamCallbacks?: ChatCompletionStreamCallbacks,
    externalSignal?: AbortSignal,
  ): Promise<InferenceResult> {
    const { modelConfig, providerName, providerConfig } = this.providerCatalog.resolveModel(
      settings,
      modelAlias,
    );
    const apiKey = process.env[providerConfig.apiKeyEnv];

    if (!apiKey) {
      throw new InferenceError(`Umgebungsvariable '${providerConfig.apiKeyEnv}' ist nicht gesetzt.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.llm.requestTimeoutMs);
    const abortHandler = (): void => controller.abort();

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    try {
      let tokenParameterName: TokenParameterName = "max_tokens";
      const enableStreaming =
        typeof streamCallbacks?.onTextDelta === "function" ||
        typeof streamCallbacks?.onReasoningDelta === "function";
      let requestBody = this.requestBodyFactory.buildRequestBody(
        modelConfig,
        messages,
        tokenParameterName,
        enableStreaming,
      );
      let response = await sendChatCompletionRequest(providerConfig, apiKey, requestBody, controller.signal);
      let payload: ChatCompletionResponse | null = null;
      let streamPayload: Awaited<ReturnType<typeof readChatCompletionStream>> | null = null;

      if (enableStreaming) {
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream")) {
          streamPayload = await readChatCompletionStream(response, streamCallbacks);
        } else {
          payload = (await response.json()) as ChatCompletionResponse;
        }
      } else {
        payload = (await response.json()) as ChatCompletionResponse;
      }

      if (payload && shouldRetryWithMaxCompletionTokens(response, payload, tokenParameterName)) {
        tokenParameterName = "max_completion_tokens";
        requestBody = this.requestBodyFactory.buildRequestBody(
          modelConfig,
          messages,
          tokenParameterName,
          enableStreaming,
        );
        response = await sendChatCompletionRequest(providerConfig, apiKey, requestBody, controller.signal);
        if (enableStreaming) {
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("text/event-stream")) {
            streamPayload = await readChatCompletionStream(response, streamCallbacks);
            payload = null;
          } else {
            payload = (await response.json()) as ChatCompletionResponse;
            streamPayload = null;
          }
        } else {
          payload = (await response.json()) as ChatCompletionResponse;
        }
      }

      if (!response.ok) {
        const reason =
          payload?.error?.message ??
          streamPayload?.rawChunks.at(-1)?.error?.message ??
          response.statusText;
        debugCollector?.recordChat({
          kind: "chat",
          timestamp: new Date().toISOString(),
          purpose: debugMetadata?.purpose ?? "chat_completion",
          scope: debugMetadata?.scope ?? "general",
          modelAlias,
          providerName,
          providerModelId: modelConfig.model,
          tokenParameterName,
          success: false,
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          error: reason,
        });
        throw new InferenceError(`Inference-Request fehlgeschlagen (${response.status}): ${reason}`);
      }

      const usage = payload ? extractUsage(payload) : streamPayload?.usage ?? extractUsage({});
      debugCollector?.recordChat({
        kind: "chat",
        timestamp: new Date().toISOString(),
        purpose: debugMetadata?.purpose ?? "chat_completion",
        scope: debugMetadata?.scope ?? "general",
        modelAlias,
        providerName,
        providerModelId: modelConfig.model,
        tokenParameterName,
        success: true,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      });

      return {
        modelAlias,
        providerName,
        providerModelId: modelConfig.model,
        text: payload ? extractText(payload) : streamPayload?.text ?? "",
        reasoning: payload ? extractReasoning(payload).trim() : streamPayload?.reasoning ?? "",
        usage,
        requestBody,
        rawResponse: payload ?? streamPayload?.rawChunks ?? [],
      };
    } catch (error) {
      if (error instanceof InferenceError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        if (externalSignal?.aborted) {
          throw new InferenceError("Inference-Request wurde abgebrochen.");
        }

        throw new InferenceError("Inference-Request hat das Timeout erreicht.");
      }

      const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
      debugCollector?.recordChat({
        kind: "chat",
        timestamp: new Date().toISOString(),
        purpose: debugMetadata?.purpose ?? "chat_completion",
        scope: debugMetadata?.scope ?? "general",
        modelAlias,
        providerName,
        providerModelId: modelConfig.model,
        tokenParameterName: "max_tokens",
        success: false,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        error: message,
      });
      throw new InferenceError(`Inference-Request konnte nicht abgeschlossen werden: ${message}`);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortHandler);
    }
  }

  async createEmbedding(
    settings: AppSettings,
    input: string,
    debugCollector?: DebugCollector,
    debugMetadata?: DebugEmbeddingMetadata,
  ): Promise<number[]> {
    const embeddingConfig = settings.scriptRegistry.embeddings;
    const providerConfig = settings.llm.providers[embeddingConfig.provider];

    if (!providerConfig) {
      throw new InferenceError(`Provider '${embeddingConfig.provider}' ist nicht konfiguriert.`);
    }

    const apiKey = process.env[providerConfig.apiKeyEnv];
    if (!apiKey) {
      throw new InferenceError(`Umgebungsvariable '${providerConfig.apiKeyEnv}' ist nicht gesetzt.`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), embeddingConfig.requestTimeoutMs);

    try {
      const response = await fetch(`${providerConfig.baseUrl}/embeddings`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...providerConfig.defaultHeaders,
        },
        body: JSON.stringify({
          model: embeddingConfig.model,
          input,
        }),
      });

      const payload = (await response.json()) as EmbeddingResponse;
      if (!response.ok) {
        const reason = payload.error?.message ?? response.statusText;
        debugCollector?.recordEmbedding(buildEmbeddingDebugEvent({
          kind: "embedding",
          timestamp: new Date().toISOString(),
          purpose: debugMetadata?.purpose ?? "embedding",
          scope: debugMetadata?.scope ?? "general",
          tier: debugMetadata?.tier,
          providerName: embeddingConfig.provider,
          model: embeddingConfig.model,
          inputChars: input.length,
          success: false,
          error: reason,
        }));
        throw new InferenceError(`Embedding-Request fehlgeschlagen (${response.status}): ${reason}`);
      }

      const embedding = payload.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
        debugCollector?.recordEmbedding(buildEmbeddingDebugEvent({
          kind: "embedding",
          timestamp: new Date().toISOString(),
          purpose: debugMetadata?.purpose ?? "embedding",
          scope: debugMetadata?.scope ?? "general",
          tier: debugMetadata?.tier,
          providerName: embeddingConfig.provider,
          model: embeddingConfig.model,
          inputChars: input.length,
          success: false,
          error: "Embedding-Antwort enthielt keinen gueltigen Vektor.",
        }));
        throw new InferenceError("Embedding-Antwort enthielt keinen gueltigen Vektor.");
      }

      debugCollector?.recordEmbedding(buildEmbeddingDebugEvent({
        kind: "embedding",
        timestamp: new Date().toISOString(),
        purpose: debugMetadata?.purpose ?? "embedding",
        scope: debugMetadata?.scope ?? "general",
        tier: debugMetadata?.tier,
        providerName: embeddingConfig.provider,
        model: embeddingConfig.model,
        inputChars: input.length,
        success: true,
      }));
      return embedding;
    } catch (error) {
      if (error instanceof InferenceError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new InferenceError("Embedding-Request hat das Timeout erreicht.");
      }

      const message = error instanceof Error ? error.message : "Unbekannter Fehler.";
      debugCollector?.recordEmbedding(buildEmbeddingDebugEvent({
        kind: "embedding",
        timestamp: new Date().toISOString(),
        purpose: debugMetadata?.purpose ?? "embedding",
        scope: debugMetadata?.scope ?? "general",
        tier: debugMetadata?.tier,
        providerName: embeddingConfig.provider,
        model: embeddingConfig.model,
        inputChars: input.length,
        success: false,
        error: message,
      }));
      throw new InferenceError(`Embedding-Request konnte nicht abgeschlossen werden: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
