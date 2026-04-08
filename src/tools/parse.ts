import { getRegisteredToolNames } from "./registry";
import type { ToolCall } from "./types";

export function parseAssistantToolResponse(
  rawText: string,
):
  | { type: "final"; message: string }
  | { type: "tool_call"; call: ToolCall }
  | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalizedText =
    trimmed.startsWith("```") && trimmed.endsWith("```")
      ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
      : trimmed;

  let parsed: unknown;

  try {
    parsed = JSON.parse(normalizedText) as unknown;
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const { message, tool, type } = parsed as {
    arguments?: unknown;
    message?: unknown;
    tool?: unknown;
    type?: unknown;
  };

  if (type === "final" && typeof message === "string") {
    return {
      type: "final",
      message,
    };
  }

  if (
    type === "tool_call" &&
    typeof tool === "string" &&
    getRegisteredToolNames().includes(tool)
  ) {
    return {
      type: "tool_call",
      call: {
        tool,
        arguments: (parsed as { arguments?: unknown }).arguments,
      },
    };
  }

  return null;
}
