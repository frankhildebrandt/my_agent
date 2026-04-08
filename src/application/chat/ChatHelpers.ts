import { basename } from "node:path";
import type { DebugSnapshot } from "../../debug";
import type {
  PromptDebugSegment,
  RequestDebugInfo,
  ScriptKnowledgeResponse,
  SleepConsolidationResponse,
} from "../../domain/chatTypes";
import type { ChatMessage } from "../../inference";
import type {
  LongTermFragmentDraft,
  ShortTermMemoryDebugInfo,
  TierMemoryDebugInfo,
} from "../../memory";

interface ModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

interface ModelContextLimits {
  contextWindowTokens: number | null;
}

export function formatHelpMessage(commandPrefix: string): string {
  return [
    `Verfuegbare Commands: ${commandPrefix}help, ${commandPrefix}new, ${commandPrefix}usage, ${commandPrefix}credits, ${commandPrefix}settings, ${commandPrefix}models, ${commandPrefix}use <alias>, ${commandPrefix}debug, ${commandPrefix}reset, ${commandPrefix}sleep, ${commandPrefix}sleepquiet, ${commandPrefix}memoryreset, ${commandPrefix}quit`,
    `${commandPrefix}new und ${commandPrefix}reset setzen die aktuelle Session zurueck.`,
  ].join(" ");
}

export function formatDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
}

export function formatTokenCount(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 100 ? 0 : value >= 10 ? 2 : 3)}`;
}

export function estimateTokensFromMessages(messages: ChatMessage[]): number {
  const contentChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const messageOverhead = messages.length * 12;
  return Math.max(1, Math.ceil((contentChars + messageOverhead) / 4));
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^openai\//u, "");
}

export function inferModelPricing(modelId: string): ModelPricing | null {
  const normalized = normalizeModelId(modelId);

  if (normalized.includes("gpt-5") && normalized.includes("mini")) {
    return {
      inputUsdPer1M: 0.25,
      outputUsdPer1M: 2,
    };
  }

  if (normalized.includes("gpt-5")) {
    return {
      inputUsdPer1M: 1.25,
      outputUsdPer1M: 10,
    };
  }

  if (normalized.includes("gpt-4.1-mini")) {
    return {
      inputUsdPer1M: 0.4,
      outputUsdPer1M: 1.6,
    };
  }

  return null;
}

export function inferModelContextLimits(modelId: string): ModelContextLimits {
  const normalized = normalizeModelId(modelId);

  if (normalized.includes("gpt-5")) {
    return {
      contextWindowTokens: 400_000,
    };
  }

  if (normalized.includes("gpt-4.1")) {
    return {
      contextWindowTokens: 1_047_576,
    };
  }

  return {
    contextWindowTokens: null,
  };
}

export function estimateCreditEquivalentTokens(usd: number, usdPer1M: number): number {
  if (!Number.isFinite(usd) || usd <= 0 || usdPer1M <= 0) {
    return 0;
  }

  return Math.floor((usd / usdPer1M) * 1_000_000);
}

export async function fetchJsonWithBearer(
  url: string,
  apiKey: string,
  defaultHeaders?: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...defaultHeaders,
    },
  });

  const payload = (await response.json()) as { error?: { message?: string }; message?: string };
  if (!response.ok) {
    const reason = payload?.error?.message ?? payload?.message ?? response.statusText;
    throw new Error(`HTTP ${response.status}: ${reason}`);
  }

  return payload;
}

function normalizeJsonResponse(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "").trim();
}

export function parseSleepConsolidationResponse(
  rawResponse: string,
  maxFragments: number,
): SleepConsolidationResponse {
  const normalized = normalizeJsonResponse(rawResponse);
  const parsed = JSON.parse(normalized) as Partial<SleepConsolidationResponse>;
  const fragments = Array.isArray(parsed.fragments) ? parsed.fragments : [];
  const midTermFragments = Array.isArray(parsed.midTermFragments) ? parsed.midTermFragments : [];
  const longTermFragments = Array.isArray(parsed.longTermFragments) ? parsed.longTermFragments : [];
  const toFragmentList = (items: unknown[]): LongTermFragmentDraft[] =>
    items
      .filter((fragment): fragment is LongTermFragmentDraft => {
        if (typeof fragment !== "object" || fragment === null) {
          return false;
        }

        const candidate = fragment as Partial<LongTermFragmentDraft>;
        return typeof candidate.title === "string" && typeof candidate.content === "string";
      })
      .slice(0, maxFragments);

  return {
    midTermFragments: toFragmentList(midTermFragments.length > 0 ? midTermFragments : fragments),
    longTermFragments: toFragmentList(longTermFragments),
  };
}

export function parseScriptKnowledgeResponse(
  rawResponse: string,
  fallbackDescription: string,
  fallbackUsage: string,
  scriptPath: string,
): ScriptKnowledgeResponse {
  const normalized = normalizeJsonResponse(rawResponse);
  const parsed = JSON.parse(normalized) as Partial<ScriptKnowledgeResponse>;
  const description =
    typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description.trim()
      : fallbackDescription;
  const usage =
    typeof parsed.usage === "string" && parsed.usage.trim().length > 0
      ? parsed.usage.trim()
      : fallbackUsage;
  const midTermTitle =
    typeof parsed.midTermTitle === "string" && parsed.midTermTitle.trim().length > 0
      ? parsed.midTermTitle.trim()
      : `Tool ${basename(scriptPath)}`;
  const midTermContent =
    typeof parsed.midTermContent === "string" && parsed.midTermContent.trim().length > 0
      ? parsed.midTermContent.trim()
      : `Skript ${scriptPath}.\nNutzen: ${description}\nUsage: ${usage}`;

  return {
    description,
    usage,
    midTermTitle,
    midTermContent,
  };
}

export function buildScriptKnowledgeMessages(
  scriptPath: string,
  fallbackDescription: string,
  fallbackUsage: string,
  toolResultText: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "Du fasst die erfolgreiche Verwendung eines neu erzeugten Hilfsskripts kompakt zusammen.",
        "Antworte ausschliesslich mit genau einem JSON-Objekt ohne Markdown.",
        'Format: {"description":"...","usage":"...","midTermTitle":"...","midTermContent":"..."}',
        "Regeln:",
        "- description: 1 kurzer Satz zum Nutzen des Skripts.",
        "- usage: 1 kurzer Satz, wie das Skript aufgerufen wird und welche Argumente wichtig sind.",
        "- midTermTitle: kurzer, konkreter Titel fuer Mid-Term-Memory.",
        "- midTermContent: 2 bis 4 saubere Saetze mit Name/Pfad, Nutzen und Usage.",
        "- Bleibe bei konkreten, wiederverwendbaren Aussagen und nenne das Skript beim Namen.",
        "- Erfinde keine Parameter, die im Tool-Ergebnis nicht gestuetzt werden.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Skriptpfad: ${scriptPath}`,
        `Vorlaeufige Beschreibung: ${fallbackDescription}`,
        `Fallback-Usage: ${fallbackUsage}`,
        "Tool-Ergebnis:",
        toolResultText,
      ].join("\n"),
    },
  ];
}

export function buildSleepMessages(snapshot: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "Du verdichtest Short-Term-Memory in kleines, wiederverwendbares Long-Term-Memory.",
        "Antworte ausschliesslich mit genau einem JSON-Objekt ohne Markdown.",
        'Format: {"midTermFragments":[{"title":"...","content":"..."}],"longTermFragments":[{"title":"...","content":"..."}]}',
        "Regeln:",
        "- midTermFragments sind verdichtete, relevante Erinnerungen mit begrenzter Haltbarkeit. Sie sollen Dubletten ersetzen und das aktuell nuetzliche Arbeitswissen kompakt halten.",
        "- longTermFragments sind nur wirklich bewaehrte, sichere Learnings: Vorgehen, Konventionen oder Erkenntnisse, die bereits schnell zu guten Ergebnissen gefuehrt haben.",
        "- Wenn in der Session Tools oder Hilfsskripte erzeugt, angepasst oder erfolgreich benutzt wurden, sollen diese bevorzugt als eigene Memory-Fragmente festgehalten werden.",
        "- Solche Fragmente muessen die konkreten Namen der Tools oder Skripte nennen und knapp erklaeren, wie sie funktionieren, welche Eingaben oder Parameter sie erwarten und wofuer sie geeignet sind.",
        "- Bewaehrte, mehrfach nuetzliche Tools und Skripte gehoeren bevorzugt in longTermFragments; einmalig relevante Tool-Kontexte eher in midTermFragments.",
        "- Ein longTermFragment ist nur dann sinnvoll, wenn es gegenueber Weglassen klaren Mehrwert bringt und dabei moeglichst wenig Tokens kostet.",
        "- Verwirf longTerm-Kandidaten, die nur eine allgemeine Beobachtung wiederholen, keinen konkreten Skript-/Tool-Namen nennen oder keine stabile wiederverwendbare Regel enthalten.",
        "- Wenn ein Tool- oder Skript-Learning ohne den konkreten Namen wie z. B. einer Datei oder eines Tool-Identifiers nicht nuetzlich waere, dann speichere es gar nicht.",
        "- Erzeuge mehrere kleine, thematisch saubere Fragmente statt Sammelnotizen.",
        "- Verwirf fluechtige Aufgaben, Rohlogs, Tool-Rauschen und Wiederholungen.",
        "- Wenn ein longTermFragment erzeugt wird, soll es nicht zusaetzlich identisch in midTermFragments wiederholt werden.",
        "- Wenn nichts fuer einen Tier relevant ist, liefere dort ein leeres Array.",
      ].join("\n"),
    },
    {
      role: "user",
      content: snapshot,
    },
  ];
}

function formatPromptSegments(segments: PromptDebugSegment[]): string {
  if (segments.length === 0) {
    return "Prompt:\n- keine Segmente";
  }

  return [
    "Prompt:",
    ...segments.map(
      (segment, index) =>
        `${index + 1}. [${segment.role}] ${segment.label}\n${segment.content || "(leer)"}`,
    ),
  ].join("\n");
}

function formatMemoryDebugInfo(
  shortTerm: ShortTermMemoryDebugInfo,
  midTerm: TierMemoryDebugInfo,
  longTerm: TierMemoryDebugInfo,
): string {
  const sections: string[] = [];
  const shortTermSources =
    shortTerm.sources.length === 0
      ? "- keine Quellen"
      : shortTerm.sources.map((source) => `- ${source.source}: ${source.text}`).join("\n");

  sections.push(
    [
      `Short-Term (${shortTerm.mode}):`,
      shortTerm.text.length > 0 ? shortTerm.text : "(leer)",
      "Quellen:",
      shortTermSources,
    ].join("\n"),
  );

  for (const tier of [midTerm, longTerm]) {
    const header = `${tier.tier} retrieval=${tier.retrievalMode} embeddingAttempted=${tier.embeddingAttempted} embeddingSucceeded=${tier.embeddingSucceeded}`;
    const entries =
      tier.usedEntries.length === 0
        ? "- keine Fragmente"
        : tier.usedEntries
            .map(
              (entry) =>
                `- ${entry.title} [id:${entry.id} path:${entry.path} score:${entry.score.toFixed(4)} source:${entry.scoreSource}]`,
            )
            .join("\n");
    sections.push(
      [
        header,
        "Fragmente:",
        entries,
        "Block:",
        tier.text.length > 0 ? tier.text : "(leer)",
      ].join("\n"),
    );
  }

  return ["Memory:", ...sections].join("\n\n");
}

function formatEmbeddingDebug(snapshot: DebugSnapshot): string {
  if (snapshot.embeddings.length === 0) {
    return "Embeddings:\n- keine Embedding-Aufrufe";
  }

  return [
    "Embeddings:",
    ...snapshot.embeddings.map((event) => {
      const status = event.success ? "ok" : `fehler=${event.error ?? "unbekannt"}`;
      const tier = event.tier ? ` tier=${event.tier}` : "";
      return `- ${event.timestamp} purpose=${event.purpose} scope=${event.scope}${tier} provider=${event.providerName} model=${event.model} chars=${event.inputChars} ${status}`;
    }),
  ].join("\n");
}

function formatChatDebug(snapshot: DebugSnapshot): string {
  if (snapshot.chats.length === 0) {
    return "Chats:\n- keine Chat-Requests";
  }

  return [
    "Chats:",
    ...snapshot.chats.map((event) => {
      const status = event.success ? "ok" : `fehler=${event.error ?? "unbekannt"}`;
      return `- ${event.timestamp} purpose=${event.purpose} scope=${event.scope} alias=${event.modelAlias} provider=${event.providerName} model=${event.providerModelId} tokenParam=${event.tokenParameterName} in=${formatTokenCount(event.inputTokens)} out=${formatTokenCount(event.outputTokens)} total=${formatTokenCount(event.totalTokens)} ${status}`;
    }),
  ].join("\n");
}

export function renderDebugReport(requestDebug: RequestDebugInfo, snapshot: DebugSnapshot): string {
  return [
    "DEBUG",
    `Model: ${requestDebug.modelAlias} -> ${requestDebug.providerName}/${requestDebug.providerModelId}`,
    formatEmbeddingDebug(snapshot),
    formatChatDebug(snapshot),
    formatMemoryDebugInfo(requestDebug.shortTerm, requestDebug.midTerm, requestDebug.longTerm),
    formatPromptSegments(requestDebug.promptSegments),
  ].join("\n\n");
}

