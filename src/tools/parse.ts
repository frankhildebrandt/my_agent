import { getRegisteredToolNames } from "./registry";
import type { ToolCall } from "./types";

export type AssistantToolParseResult =
  | { ok: true; response: { type: "final"; message: string } | { type: "tool_call"; call: ToolCall } }
  | {
      ok: false;
      reason:
        | "empty_response"
        | "no_json_object"
        | "json_not_object"
        | "missing_or_invalid_type"
        | "final_missing_message"
        | "tool_call_missing_tool"
        | "unknown_tool";
      details: string;
      snippet: string;
    };

function extractJsonObjects(rawText: string): string[] {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const normalizedText =
    trimmed.startsWith("```") && trimmed.endsWith("```")
      ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
      : trimmed;

  const objects: string[] = [];
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < normalizedText.length; index += 1) {
    const character = normalizedText[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "{") {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        objects.push(normalizedText.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return objects;
}

function buildSnippet(rawText: string): string {
  const compact = rawText.replace(/\s+/gu, " ").trim();
  if (compact.length <= 220) {
    return compact;
  }
  return `${compact.slice(0, 217)}...`;
}

export function analyzeAssistantToolResponse(
  rawText: string,
): AssistantToolParseResult {
  const trimmed = rawText.trim();
  const snippet = buildSnippet(rawText);
  if (trimmed.length === 0) {
    return {
      ok: false,
      reason: "empty_response",
      details: "Die Modellantwort war leer.",
      snippet,
    };
  }

  const candidates = extractJsonObjects(rawText);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "no_json_object",
      details: "Es wurde kein vollstaendiges JSON-Objekt gefunden.",
      snippet,
    };
  }

  let lastFailure: AssistantToolParseResult | null = null;
  for (const candidateText of candidates) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(candidateText) as unknown;
    } catch {
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      lastFailure = {
        ok: false,
        reason: "json_not_object",
        details: "Ein JSON-Wert wurde gefunden, aber kein einzelnes Objekt.",
        snippet: buildSnippet(candidateText),
      };
      continue;
    }

    const { message, tool, type } = parsed as {
      arguments?: unknown;
      message?: unknown;
      tool?: unknown;
      type?: unknown;
    };

    if (type === "final") {
      if (typeof message === "string") {
        return {
          ok: true,
          response: {
            type: "final",
            message,
          },
        };
      }
      lastFailure = {
        ok: false,
        reason: "final_missing_message",
        details: "Ein final-Objekt wurde gefunden, aber ohne String-Feld message.",
        snippet: buildSnippet(candidateText),
      };
      continue;
    }

    if (type === "tool_call") {
      if (typeof tool !== "string" || tool.length === 0) {
        lastFailure = {
          ok: false,
          reason: "tool_call_missing_tool",
          details: "Ein tool_call-Objekt wurde gefunden, aber ohne gueltigen Tool-Namen.",
          snippet: buildSnippet(candidateText),
        };
        continue;
      }

      if (!getRegisteredToolNames().includes(tool)) {
        lastFailure = {
          ok: false,
          reason: "unknown_tool",
          details: `Ein tool_call wurde gefunden, aber das Tool ist nicht registriert: ${tool}.`,
          snippet: buildSnippet(candidateText),
        };
        continue;
      }

      return {
        ok: true,
        response: {
          type: "tool_call",
          call: {
            tool,
            arguments: (parsed as { arguments?: unknown }).arguments,
          },
        },
      };
    }

    lastFailure = {
      ok: false,
      reason: "missing_or_invalid_type",
      details: "Ein JSON-Objekt wurde gefunden, aber type war weder tool_call noch final.",
      snippet: buildSnippet(candidateText),
    };
  }

  return (
    lastFailure ?? {
      ok: false,
      reason: "no_json_object",
      details: "Es wurde kein auswertbares JSON-Objekt gefunden.",
      snippet,
    }
  );
}

export function parseAssistantToolResponse(
  rawText: string,
):
  | { type: "final"; message: string }
  | { type: "tool_call"; call: ToolCall }
  | null {
  const analysis = analyzeAssistantToolResponse(rawText);
  return analysis.ok ? analysis.response : null;
}
