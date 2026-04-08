import type { AppSettings } from "../settings";
import type { DebugCollector } from "../debug";

export interface ToolCall {
  tool: string;
  arguments?: unknown;
}

export interface ToolResult {
  ok: boolean;
  tool: string;
  summary: string;
  output: Record<string, unknown>;
}

export interface ToolExecutionCallbacks {
  onUpdate?: (chunk: string) => void;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export interface AgentToolDefinition {
  name: string;
  prompt: string;
  execute: (
    settings: AppSettings,
    args: unknown,
    debugCollector?: DebugCollector,
    callbacks?: ToolExecutionCallbacks,
    context?: ToolExecutionContext,
  ) => Promise<ToolResult> | ToolResult;
}
