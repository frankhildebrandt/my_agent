import { basename } from "node:path";
import type { DebugSnapshot } from "../../debug";
import type {
  MemoryRoundupResponse,
  PromptDebugSegment,
  RequestDebugInfo,
  ScriptKnowledgeResponse,
  SleepConsolidationResponse,
} from "../../domain/chatTypes";
import type { ChatMessage } from "../../inference";
import type {
  LongTermFragmentDraft,
  MemoryFeedbackEntry,
  PersistedMemoryFragment,
  ShortTermConversationEntry,
  SleepFeedbackEntry,
  ShortTermMemoryDebugInfo,
  TierMemoryDebugInfo,
  ToolRoutingLearning,
} from "../../memory";
import { parseToolRoutingLearningFragment } from "../../infrastructure/memory/memoryShared";

interface ModelPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
}

interface ModelContextLimits {
  contextWindowTokens: number | null;
}

export function formatHelpMessage(commandPrefix: string): string {
  return [
    `Verfuegbare Commands: ${commandPrefix}help, ${commandPrefix}new, ${commandPrefix}usage, ${commandPrefix}credits, ${commandPrefix}settings, ${commandPrefix}models, ${commandPrefix}use <alias>, ${commandPrefix}debug, ${commandPrefix}reset, ${commandPrefix}sleep, ${commandPrefix}sleepquiet, ${commandPrefix}memoryroundup, ${commandPrefix}memoryreset, ${commandPrefix}quit`,
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

function parseConsolidationResponse(
  rawResponse: string,
  maxFragments: number,
): SleepConsolidationResponse {
  const normalized = normalizeJsonResponse(rawResponse);
  const parsed = JSON.parse(normalized) as Partial<SleepConsolidationResponse>;
  const fragments = Array.isArray(parsed.fragments) ? parsed.fragments : [];
  const midTermFragments = Array.isArray(parsed.midTermFragments) ? parsed.midTermFragments : [];
  const longTermFragments = Array.isArray(parsed.longTermFragments) ? parsed.longTermFragments : [];
  const problemMidTermFragments = Array.isArray(parsed.problemMidTermFragments)
    ? parsed.problemMidTermFragments
    : [];
  const problemLongTermFragments = Array.isArray(parsed.problemLongTermFragments)
    ? parsed.problemLongTermFragments
    : [];
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

  const parsedFragments = {
    midTermFragments: toFragmentList(midTermFragments.length > 0 ? midTermFragments : fragments),
    longTermFragments: toFragmentList(longTermFragments),
    problemMidTermFragments: toFragmentList(problemMidTermFragments),
    problemLongTermFragments: toFragmentList(problemLongTermFragments),
  };

  return {
    ...parsedFragments,
    toolRoutingLearnings: extractToolRoutingLearningsFromFragments([
      ...parsedFragments.midTermFragments,
      ...parsedFragments.longTermFragments,
      ...parsedFragments.problemMidTermFragments,
      ...parsedFragments.problemLongTermFragments,
    ]),
  };
}

export function parseSleepConsolidationResponse(
  rawResponse: string,
  maxFragments: number,
): SleepConsolidationResponse {
  return parseConsolidationResponse(rawResponse, maxFragments);
}

export function parseMemoryRoundupResponse(
  rawResponse: string,
  maxFragments: number,
): MemoryRoundupResponse {
  return parseConsolidationResponse(rawResponse, maxFragments);
}

export function mergeConsolidationFragments(response: {
  midTermFragments: LongTermFragmentDraft[];
  longTermFragments: LongTermFragmentDraft[];
  problemMidTermFragments?: LongTermFragmentDraft[];
  problemLongTermFragments?: LongTermFragmentDraft[];
}): { midTermFragments: LongTermFragmentDraft[]; longTermFragments: LongTermFragmentDraft[] } {
  return {
    midTermFragments: [...response.midTermFragments, ...(response.problemMidTermFragments ?? [])],
    longTermFragments: [...response.longTermFragments, ...(response.problemLongTermFragments ?? [])],
  };
}

function extractToolRoutingLearningsFromFragments(
  fragments: LongTermFragmentDraft[],
): ToolRoutingLearning[] {
  const learnings = new Map<string, ToolRoutingLearning>();

  for (const fragment of fragments) {
    const parsed = parseToolRoutingLearningFragment(fragment.title, fragment.content);
    if (!parsed) {
      continue;
    }

    const key = [
      parsed.requestPattern,
      parsed.preferredTools.join(","),
      parsed.preferredScripts.join(","),
      parsed.preferredModules.join(","),
      parsed.avoidDiscoveryTools.join(","),
      parsed.fallback,
    ].join("::");
    if (!learnings.has(key)) {
      learnings.set(key, parsed);
    }
  }

  return [...learnings.values()];
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

function formatMemoryFeedback(entries: MemoryFeedbackEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  return [
    "Persistierte negative Erfahrungen und Problemhinweise:",
    ...entries.map(
      (entry, index) => `${index + 1}. [${entry.scope}/${entry.outcome}] ${entry.createdAt}: ${entry.message}`,
    ),
  ].join("\n");
}

function formatFailureSignals(entries: MemoryFeedbackEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  return [
    "Aktuelle Failure-Signale aus dem Short-Term-Memory:",
    ...entries.map(
      (entry, index) => `${index + 1}. [${entry.scope}/${entry.outcome}] ${entry.createdAt}: ${entry.message}`,
    ),
  ].join("\n");
}

function formatTierFragmentsForRoundup(label: string, fragments: PersistedMemoryFragment[]): string {
  if (fragments.length === 0) {
    return `${label}:\n(keine Fragmente)`;
  }

  return [
    `${label}:`,
    ...fragments.map(
      (fragment, index) =>
        `${index + 1}. ${fragment.title} [${fragment.updatedAt}]\n${fragment.content}`,
    ),
  ].join("\n\n");
}

export function buildSleepMessages(
  snapshot: string,
  feedbackEntries: SleepFeedbackEntry[] = [],
  failureSignals: MemoryFeedbackEntry[] = [],
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "Du verdichtest Short-Term-Memory in kleines, wiederverwendbares Long-Term-Memory.",
        "Antworte ausschliesslich mit genau einem JSON-Objekt ohne Markdown.",
        'Format: {"midTermFragments":[{"title":"...","content":"..."}],"longTermFragments":[{"title":"...","content":"..."}],"problemMidTermFragments":[{"title":"...","content":"..."}],"problemLongTermFragments":[{"title":"...","content":"..."}]}',
        "Regeln:",
        "- midTermFragments sind verdichtete, relevante Erinnerungen mit begrenzter Haltbarkeit. Sie sollen Dubletten ersetzen und das aktuell nuetzliche Arbeitswissen kompakt halten.",
        "- longTermFragments sind nur wirklich bewaehrte, sichere Learnings: Vorgehen, Konventionen oder Erkenntnisse, die bereits schnell zu guten Ergebnissen gefuehrt haben.",
        "- problemMidTermFragments und problemLongTermFragments halten negative Erfahrungen fest, aber nur dann, wenn daraus konkrete Gegenmassnahmen, Warnsignale oder robustere Vorgehensweisen abgeleitet werden koennen.",
        "- Wenn in der Session Tools oder Hilfsskripte erzeugt, angepasst oder erfolgreich benutzt wurden, sollen diese bevorzugt als eigene Memory-Fragmente festgehalten werden.",
        "- Solche Fragmente muessen die konkreten Namen der Tools oder Skripte nennen und knapp erklaeren, wie sie funktionieren, welche Eingaben oder Parameter sie erwarten und wofuer sie geeignet sind.",
        "- Fuer wiederkehrende Anfragebilder darfst du ein eigenes Routing-Fragment erzeugen: Titel 'tool routing memory: <anfragebild>'.",
        "- Routing-Fragmente muessen genau diese Felder enthalten: REQUEST_PATTERN:, PREFER_TOOLS:, PREFER_SCRIPTS:, PREFER_MODULES:, AVOID_DISCOVERY:, DISCOVERY_FALLBACK:, RATIONALE:.",
        "- DISCOVERY_FALLBACK soll standardmaessig after_first_failure_or_empty_result sein, damit Discovery erst nach einem Fehlschlag oder einem leeren Ergebnis wieder erlaubt wird.",
        "- Ein Routing-Long-Term-Fragment ist nur dann erlaubt, wenn es konkret Tool-IDs nennt und gegenueber generischer Discovery klar Tokens oder Aufwand spart.",
        "- Bewaehrte, mehrfach nuetzliche Tools und Skripte gehoeren bevorzugt in longTermFragments; einmalig relevante Tool-Kontexte eher in midTermFragments.",
        "- Wenn Fehlversuche, gescheiterte Anfragen, Script-Probleme oder Zielverfehlungen erkennbar sind, fasse sie als problemorientierte Learnings zusammen: Problem, Ausloeser, Gegenmassnahme.",
        "- Ein longTermFragment ist nur dann sinnvoll, wenn es gegenueber Weglassen klaren Mehrwert bringt und dabei moeglichst wenig Tokens kostet.",
        "- Verwirf longTerm-Kandidaten, die nur eine allgemeine Beobachtung wiederholen, keinen konkreten Skript-/Tool-Namen nennen, keine stabile wiederverwendbare Regel enthalten oder keinen produktiven Kostenvorteil bringen.",
        "- Wenn ein Tool- oder Skript-Learning ohne den konkreten Namen wie z. B. einer Datei oder eines Tool-Identifiers nicht nuetzlich waere, dann speichere es gar nicht.",
        "- Erzeuge mehrere kleine, thematisch saubere Fragmente statt Sammelnotizen.",
        "- Verwirf fluechtige Aufgaben, Rohlogs, Tool-Rauschen und Wiederholungen.",
        "- Wenn ein longTermFragment erzeugt wird, soll es nicht zusaetzlich identisch in midTermFragments wiederholt werden.",
        "- Wenn nichts fuer einen Tier relevant ist, liefere dort ein leeres Array.",
        "- Falls fruehere Sleep-Fehlschlaege genannt werden, vermeide dieselben Fehler aktiv und liefere besonders sauberes, parsebares JSON.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        formatMemoryFeedback(feedbackEntries),
        formatFailureSignals(failureSignals),
        snapshot,
      ]
        .filter((part) => part.trim().length > 0)
        .join("\n\n"),
    },
  ];
}

export function buildMemoryRoundupMessages(
  midTermFragments: PersistedMemoryFragment[],
  longTermFragments: PersistedMemoryFragment[],
  feedbackEntries: MemoryFeedbackEntry[] = [],
  failureSignals: MemoryFeedbackEntry[] = [],
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "Du ueberarbeitest das gesamte persistierte Agent-Memory vollstaendig.",
        "Antworte ausschliesslich mit genau einem JSON-Objekt ohne Markdown.",
        'Format: {"midTermFragments":[{"title":"...","content":"..."}],"longTermFragments":[{"title":"...","content":"..."}],"problemMidTermFragments":[{"title":"...","content":"..."}],"problemLongTermFragments":[{"title":"...","content":"..."}]}',
        "Regeln:",
        "- Fuehre aehnliche oder redundante Fragmente zusammen und wirf veraltete oder schwache Fragmente weg.",
        "- Halte Mid-Term-Memory kompakt und arbeitsnah.",
        "- Long-Term-Memory soll nur stabile, wiederverwendbare Regeln, bewaehrte Workflows oder robuste Tool-/Skript-Learnings enthalten.",
        "- Wiederkehrende Tool-Routing-Learnings sollen als Fragmente mit Titel 'tool routing memory: <anfragebild>' und den Feldern REQUEST_PATTERN, PREFER_TOOLS, PREFER_SCRIPTS, PREFER_MODULES, AVOID_DISCOVERY, DISCOVERY_FALLBACK, RATIONALE notiert werden.",
        "- Solche Routing-Long-Term-Fragmente nur behalten, wenn sie konkrete Tool-IDs nennen und Discovery-Aufwand oder Tokenkosten erkennbar reduzieren.",
        "- Negative Erfahrungen sollen nicht nur erwaehnt, sondern als problemorientierte Learnings mit klaren Gegenmassnahmen formuliert werden.",
        "- Wenn mehrere Fehlversuche auf dasselbe Muster hindeuten, fasse sie in ein staerkeres Problemfragment zusammen.",
        "- Problemfragmente gehoeren nur dann nach longTermFragments, wenn die Gegenmassnahme stabil und wiederverwendbar ist.",
        "- Nenne konkrete Tools, Skripte, Dateitypen, Request-Muster oder Ausloeser, wenn sie fuer die Gegenmassnahme wichtig sind.",
        "- Liefere ein vollstaendiges Ersatz-Set fuer Mid-Term und Long-Term. Alles Relevante muss in deinen Arrays enthalten sein.",
        "- Vermeide Dubletten zwischen midTermFragments/problemMidTermFragments und longTermFragments/problemLongTermFragments.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        formatMemoryFeedback(feedbackEntries),
        formatFailureSignals(failureSignals),
        formatTierFragmentsForRoundup("Aktuelles Mid-Term-Memory", midTermFragments),
        formatTierFragmentsForRoundup("Aktuelles Long-Term-Memory", longTermFragments),
      ]
        .filter((part) => part.trim().length > 0)
        .join("\n\n"),
    },
  ];
}

function buildFeedbackMessage(
  createdAt: string,
  scope: MemoryFeedbackEntry["scope"],
  outcome: MemoryFeedbackEntry["outcome"],
  message: string,
): MemoryFeedbackEntry {
  return {
    createdAt,
    scope,
    outcome,
    message: message.trim(),
  };
}

function readErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const candidate = value as { error?: unknown; output?: { error?: unknown }; summary?: unknown };
  return (
    readErrorMessage(candidate.error) ||
    readErrorMessage(candidate.output?.error) ||
    (typeof candidate.summary === "string" ? candidate.summary.trim() : "")
  );
}

function isEmptyToolResultMetadata(metadata: Record<string, unknown>): boolean {
  const explicit = metadata.resultEmpty;
  if (typeof explicit === "boolean") {
    return explicit;
  }

  const result = metadata.result;
  if (typeof result !== "object" || result === null) {
    return false;
  }

  const output = (result as { output?: unknown }).output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return false;
  }

  const candidate = output as Record<string, unknown>;
  return ["matches", "modules", "results", "entries", "items"].some((key) => {
    const value = candidate[key];
    return Array.isArray(value) && value.length === 0;
  });
}

export function extractFailureFeedbackFromShortTermEntries(
  entries: ShortTermConversationEntry[],
): MemoryFeedbackEntry[] {
  const collected: MemoryFeedbackEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const createdAt = entry.createdAt;
    if (entry.kind === "tool_result") {
      const metadata = typeof entry.metadata === "object" && entry.metadata !== null ? entry.metadata : {};
      const success = (metadata as { success?: unknown }).success;
      if (success === false) {
        const toolName = typeof (metadata as { tool?: unknown }).tool === "string"
          ? String((metadata as { tool?: unknown }).tool)
          : "unbekanntes Tool";
        const result = (metadata as { result?: unknown }).result;
        const errorMessage = readErrorMessage(result) || entry.content;
        const message = `Tool ${toolName} fehlgeschlagen. Gegenmassnahme ableiten: ${errorMessage}`;
        const key = `tool:${message}`;
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(buildFeedbackMessage(createdAt, "tool", "failure", message));
        }
      } else if (isEmptyToolResultMetadata(metadata as Record<string, unknown>)) {
        const toolName = typeof (metadata as { tool?: unknown }).tool === "string"
          ? String((metadata as { tool?: unknown }).tool)
          : "unbekanntes Tool";
        const message = `Tool ${toolName} lieferte keinen nutzbaren Treffer. Danach ist Discovery oder ein anderer direkter Kandidat zulaessig.`;
        const key = `tool-empty:${message}`;
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(buildFeedbackMessage(createdAt, "tool", "goal_missed", message));
        }
      }
      continue;
    }

    if (entry.kind === "status" && /fehlgeschlagen/i.test(entry.content)) {
      const key = `status:${entry.content}`;
      if (!seen.has(key)) {
        seen.add(key);
        collected.push(buildFeedbackMessage(createdAt, "request", "failure", entry.content));
      }
      continue;
    }

    if (entry.kind === "loop_correction") {
      const outcome: MemoryFeedbackEntry["outcome"] =
        /nachgefordert|ungueltig|ohne tool/i.test(entry.content) ? "goal_missed" : "failure";
      const key = `loop:${entry.content}`;
      if (!seen.has(key)) {
        seen.add(key);
        collected.push(buildFeedbackMessage(createdAt, "goal", outcome, entry.content));
      }
    }
  }

  return collected;
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

function formatToolRoutingDebug(learnings: ToolRoutingLearning[]): string {
  if (learnings.length === 0) {
    return "Tool-Routing:\n- keine Routing-Hinweise";
  }

  return [
    "Tool-Routing:",
    ...learnings.map((learning) => {
      const preferred = [
        ...learning.preferredTools,
        ...learning.preferredScripts,
        ...learning.preferredModules,
      ].join(" -> ");
      const avoided = learning.avoidDiscoveryTools.join(", ") || "keine";
      return `- ${learning.requestPattern} | zuerst=${preferred} | discovery_meiden=${avoided} | fallback=${learning.fallback}`;
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
    formatToolRoutingDebug(requestDebug.toolRoutingLearnings),
    formatPromptSegments(requestDebug.promptSegments),
  ].join("\n\n");
}
