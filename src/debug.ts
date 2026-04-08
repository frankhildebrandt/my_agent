export interface DebugEmbeddingMetadata {
  purpose: string;
  scope: string;
  tier?: "shortTerm" | "midTerm" | "longTerm" | "scriptRegistry";
}

export interface DebugChatMetadata {
  purpose: string;
  scope: string;
}

export interface EmbeddingDebugEvent extends DebugEmbeddingMetadata {
  kind: "embedding";
  timestamp: string;
  providerName: string;
  model: string;
  inputChars: number;
  success: boolean;
  error?: string;
}

export interface ChatDebugEvent extends DebugChatMetadata {
  kind: "chat";
  timestamp: string;
  modelAlias: string;
  providerName: string;
  providerModelId: string;
  tokenParameterName: "max_tokens" | "max_completion_tokens";
  success: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  error?: string;
}

export interface DebugSnapshot {
  embeddings: EmbeddingDebugEvent[];
  chats: ChatDebugEvent[];
}

export class DebugCollector {
  private readonly embeddings: EmbeddingDebugEvent[] = [];
  private readonly chats: ChatDebugEvent[] = [];

  recordEmbedding(event: EmbeddingDebugEvent): void {
    this.embeddings.push(event);
  }

  recordChat(event: ChatDebugEvent): void {
    this.chats.push(event);
  }

  snapshot(): DebugSnapshot {
    return {
      embeddings: [...this.embeddings],
      chats: [...this.chats],
    };
  }
}
