import { basename } from "node:path";
import { DebugCollector } from "../../debug";
import { SessionContext } from "../session/SessionContext";
import { ContextBuilder } from "./ContextBuilder";
import {
  buildMemoryRoundupMessages,
  buildScriptKnowledgeMessages,
  buildSleepMessages,
  estimateCreditEquivalentTokens,
  estimateTokensFromMessages,
  extractFailureFeedbackFromShortTermEntries,
  fetchJsonWithBearer,
  formatDuration,
  formatHelpMessage,
  formatTokenCount,
  formatUsd,
  inferModelContextLimits,
  inferModelPricing,
  mergeConsolidationFragments,
  parseMemoryRoundupResponse,
  parseScriptKnowledgeResponse,
  parseSleepConsolidationResponse,
  renderDebugReport,
} from "./ChatHelpers";
import type { IChatView, IEditorLauncher, IInferenceClient, IMemoryRepository, IScriptRegistryRepository, IToolExecutor } from "../../domain/ports";
import type { AppSettings } from "../../settings";
import type { ChatCompletionStreamCallbacks, ChatMessage } from "../../inference";
import { InferenceError } from "../../inference";
import type { RequestDebugInfo, ScriptKnowledgeResponse } from "../../domain/chatTypes";
import type { MemoryFeedbackEntry, PersistedMemoryFragment, ShortTermConversationEntry } from "../../memory";
import { parseAssistantToolResponse } from "../../tools";
import { CommandDispatcher } from "../commands/CommandDispatcher";

interface ActiveExecutionState {
  controller: AbortController;
  label: string;
}

export class ChatController {
  private activeExecution: ActiveExecutionState | null = null;
  private readonly commandDispatcher: CommandDispatcher;

  constructor(
    private readonly settings: AppSettings,
    private readonly view: IChatView,
    private readonly sessionContext: SessionContext,
    private readonly contextBuilder: ContextBuilder,
    private readonly inferenceClient: IInferenceClient,
    private readonly toolExecutor: IToolExecutor,
    private readonly editorLauncher: IEditorLauncher,
    private readonly memoryRepository: IMemoryRepository,
    private readonly scriptRegistryRepository: IScriptRegistryRepository,
    private readonly onQuit: () => void,
  ) {
    this.commandDispatcher = new CommandDispatcher(this.settings.commands.prefix, {
      onHelp: () => {
        this.view.appendMessage("sys>", formatHelpMessage(this.settings.commands.prefix));
      },
      onNew: () => {
        this.sessionContext.reset();
        this.view.appendMessage("sys>", "Neue Session gestartet. Short-Term-Memory wurde zurueckgesetzt.");
      },
      onUsage: () => this.handleUsageCommand(),
      onCredits: () => this.handleCreditsCommand(),
      onSettings: () => this.handleSettingsCommand(),
      onModels: () => {
        this.view.appendMessage("sys>", `Modelle: ${this.formatModels()}`);
      },
      onUse: (alias) => {
        if (!this.settings.llm.models[alias]) {
          this.view.appendMessage("sys>", `Unbekanntes Modell-Alias: ${alias}`);
          return;
        }

        this.sessionContext.setActiveModel(alias);
        this.view.appendMessage("sys>", `Aktives Modell: ${this.sessionContext.activeModelAlias}`);
      },
      onDebug: () => {
        const next = this.sessionContext.toggleDebug();
        this.view.appendMessage("sys>", `Debug-Modus ${next ? "aktiv" : "inaktiv"}.`);
      },
      onReset: () => {
        this.sessionContext.reset();
        this.view.appendMessage("sys>", "Session und Short-Term-Memory zurueckgesetzt.");
      },
      onSleep: (quiet) => this.handleSleepCommand(quiet),
      onMemoryRoundup: () => this.handleMemoryRoundupCommand(),
      onMemoryReset: () => {
        this.sessionContext.reset();
        this.memoryRepository.resetAllMemory(this.settings);
        this.view.appendMessage("sys>", "Short-, Mid- und Long-Term-Memory wurden geleert.");
      },
      onQuit: () => this.onQuit(),
      onUnknown: (rawCommand) => {
        this.view.appendMessage("sys>", `Unbekanntes Command: ${rawCommand}`);
      },
    });
  }

  abortActiveExecution(): void {
    if (!this.activeExecution) {
      return;
    }

    const { controller, label } = this.activeExecution;
    if (controller.signal.aborted) {
      return;
    }

    controller.abort();
    this.view.setTransientStatus(`${label} wird abgebrochen`, "error");
    this.view.appendMessage("sys>", `Abbruch angefordert: ${label}`);
  }

  async handlePrompt(rawValue: string): Promise<void> {
    const value = rawValue.trim();
    if (value.length === 0) {
      return;
    }

    this.view.appendMessage("du>", value);

    if (this.activeExecution) {
      this.view.appendMessage(
        "sys>",
        `Bereits aktiv: ${this.activeExecution.label}. Esc bricht die laufende Ausfuehrung ab.`,
      );
      return;
    }

    if (await this.commandDispatcher.dispatch(value)) {
      return;
    }

    await this.handleChatPrompt(value);
  }

  private async handleSettingsCommand(): Promise<void> {
    try {
      await this.editorLauncher.open(this.settings.files.settingsPath, this.settings);
      this.view.appendMessage("sys>", `settings geoeffnet: ${this.settings.files.settingsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Editor konnte nicht gestartet werden.";
      this.view.appendMessage("sys>", `Fehler beim Oeffnen von settings.json: ${message}`);
    }
  }

  private formatModels(): string {
    return Object.entries(this.settings.llm.models)
      .map(([alias, modelConfig]) => {
        const marker = alias === this.sessionContext.activeModelAlias ? "*" : " ";
        return `${marker} ${alias} -> ${modelConfig.provider}/${modelConfig.model}`;
      })
      .join(" | ");
  }

  private isExecutionAborted(controller: AbortController | null | undefined): boolean {
    return controller?.signal.aborted ?? false;
  }

  private ensureExecutionNotAborted(controller: AbortController | null | undefined): void {
    if (this.isExecutionAborted(controller)) {
      throw new InferenceError("Aktuelle Ausfuehrung wurde abgebrochen.");
    }
  }

  private async handleUsageCommand(): Promise<void> {
    const query =
      [...this.sessionContext.sessionEvents].reverse().find((entry) => entry.role === "user")?.content ?? "";
    const { messages: contextMessages } = await this.contextBuilder.buildContextOverview(
      query,
      this.sessionContext.activeModelAlias,
      this.sessionContext.sessionEvents,
    );
    const modelConfig = this.settings.llm.models[this.sessionContext.activeModelAlias];
    if (!modelConfig) {
      throw new InferenceError(`Unbekanntes Modell-Alias: ${this.sessionContext.activeModelAlias}`);
    }

    const contextLimits = inferModelContextLimits(modelConfig.model);
    const estimatedPromptTokens = estimateTokensFromMessages(contextMessages);
    const estimatedOutputBudget = modelConfig.maxTokens;
    const estimatedReservedWindow = estimatedPromptTokens + estimatedOutputBudget;
    const remainingContext =
      contextLimits.contextWindowTokens === null
        ? null
        : Math.max(contextLimits.contextWindowTokens - estimatedReservedWindow, 0);

    this.view.appendMessage(
      "sys>",
      [
        `Session-Usage: Requests ${this.sessionContext.sessionUsage.requests} | in ${this.sessionContext.sessionUsage.inputTokens} | out ${this.sessionContext.sessionUsage.outputTokens} | total ${this.sessionContext.sessionUsage.totalTokens}`,
        `Kontext: geschaetzter Prompt ${estimatedPromptTokens} Tokens | reservierte Antwort ${estimatedOutputBudget} Tokens`,
        contextLimits.contextWindowTokens === null
          ? "Kontextfenster: unbekannt fuer dieses Modell"
          : `Kontextfenster: ca. ${contextLimits.contextWindowTokens} Tokens | frei ca. ${remainingContext}`,
      ].join(" | "),
    );
  }

  private async handleCreditsCommand(): Promise<void> {
    const modelConfig = this.settings.llm.models[this.sessionContext.activeModelAlias];
    if (!modelConfig) {
      throw new InferenceError(`Unbekanntes Modell-Alias: ${this.sessionContext.activeModelAlias}`);
    }

    const providerConfig = this.settings.llm.providers[modelConfig.provider];
    if (!providerConfig) {
      throw new InferenceError(`Provider '${modelConfig.provider}' ist nicht konfiguriert.`);
    }

    const apiKey = process.env[providerConfig.apiKeyEnv];
    if (!apiKey) {
      throw new InferenceError(`Umgebungsvariable '${providerConfig.apiKeyEnv}' ist nicht gesetzt.`);
    }

    const baseUrl = providerConfig.baseUrl.replace(/\/+$/u, "");
    if (!baseUrl.includes("openrouter.ai")) {
      this.view.appendMessage(
        "sys>",
        `Credits fuer ${modelConfig.provider} sind ueber diesen Provider-Endpunkt nicht verfuegbar. Unterstuetzt ist aktuell OpenRouter (/api/v1/key).`,
      );
      return;
    }

    const keyPayload = (await fetchJsonWithBearer(
      `${baseUrl}/key`,
      apiKey,
      providerConfig.defaultHeaders,
    )) as {
      data?: {
        limit_remaining?: number | null;
        limit?: number | null;
        usage?: number;
      };
    };
    const remainingCredits = keyPayload.data?.limit_remaining;
    const creditLimit = keyPayload.data?.limit;
    const lifetimeUsage = keyPayload.data?.usage;
    const pricing = inferModelPricing(modelConfig.model);

    if (remainingCredits === null) {
      this.view.appendMessage(
        "sys>",
        [
          "Credits: API-Key ist laut Provider nicht limitiert.",
          typeof creditLimit === "number" ? `Limit ${formatUsd(creditLimit)}` : "",
          typeof lifetimeUsage === "number" ? `bisher genutzt ${formatUsd(lifetimeUsage)}` : "",
        ]
          .filter((part) => part.length > 0)
          .join(" | "),
      );
      return;
    }

    if (typeof remainingCredits !== "number" || !Number.isFinite(remainingCredits)) {
      this.view.appendMessage("sys>", "Credits konnten nicht gelesen werden.");
      return;
    }

    const equivalent =
      pricing === null
        ? null
        : {
            inputTokens: estimateCreditEquivalentTokens(remainingCredits, pricing.inputUsdPer1M),
            outputTokens: estimateCreditEquivalentTokens(remainingCredits, pricing.outputUsdPer1M),
          };

    this.view.appendMessage(
      "sys>",
      [
        `Verbleibende Credits: ${formatUsd(remainingCredits)}`,
        equivalent === null
          ? "Token-Aequivalent unbekannt fuer dieses Modell"
          : `ca. ${equivalent.inputTokens} Input-Tokens oder ${equivalent.outputTokens} Output-Tokens mit ${modelConfig.model}`,
        typeof creditLimit === "number" ? `Key-Limit ${formatUsd(creditLimit)}` : "",
        typeof lifetimeUsage === "number" ? `bisher genutzt ${formatUsd(lifetimeUsage)}` : "",
      ]
        .filter((part) => part.length > 0)
        .join(" | "),
    );
  }

  private async handleSleepCommand(quiet: boolean): Promise<void> {
    if (this.activeExecution) {
      this.view.appendMessage("sys>", `Bereits aktiv: ${this.activeExecution.label}. Esc bricht die laufende Ausfuehrung ab.`);
      return;
    }

    const snapshot = this.memoryRepository.loadShortTermMemorySnapshot(
      this.settings,
      this.sessionContext.sessionEvents,
    );
    const shortTermDebug = this.memoryRepository.loadShortTermMemorySnapshotWithDebug(
      this.settings,
      this.sessionContext.sessionEvents,
    ).debug;
    const sleepFeedback = this.memoryRepository.loadSleepFeedback(this.settings);
    const failureFeedback = this.collectFailureFeedback();
    const debugCollector = this.sessionContext.debugEnabled ? new DebugCollector() : undefined;
    const sleepMessages = buildSleepMessages(snapshot, sleepFeedback, failureFeedback);

    if (snapshot.length === 0) {
      this.sessionContext.reset();
      this.view.appendMessage(
        "sys>",
        quiet
          ? "Sleep beendet. Kein Short-Term-Memory vorhanden."
          : "Sleep beendet. Kein relevantes Short-Term-Memory zum Verdichten gefunden.",
      );
      return;
    }

    this.view.setTransientStatus("Short-Term-Memory wird verdichtet", "request");
    const execution = {
      controller: new AbortController(),
      label: quiet ? "Sleepquiet" : "Sleep",
    };
    this.activeExecution = execution;

    try {
      const result = await this.inferenceClient.createChatCompletion(
        this.settings,
        this.sessionContext.activeModelAlias,
        sleepMessages,
        debugCollector,
        {
          purpose: "sleep_consolidation",
          scope: quiet ? "sleepquiet" : "sleep",
        },
        undefined,
        execution.controller.signal,
      );
      this.ensureExecutionNotAborted(execution.controller);
      this.sessionContext.recordUsage(result.usage);
      const parsed = parseSleepConsolidationResponse(
        result.text,
        Math.max(
          this.settings.memory.midTerm.maxFragmentsPerSleep,
          this.settings.memory.longTerm.maxFragmentsPerSleep,
        ),
      );
      const merged = mergeConsolidationFragments(parsed);
      const storedMidTermFragments = await this.memoryRepository.storeMidTermMemoryFragments(
        this.settings,
        merged.midTermFragments,
        debugCollector,
      );
      const storedLongTermFragments = await this.memoryRepository.storeLongTermMemoryFragments(
        this.settings,
        merged.longTermFragments,
        debugCollector,
      );
      const storedFragments = [...storedMidTermFragments, ...storedLongTermFragments];

      this.sessionContext.reset();
      this.view.clearTransientStatus();

      if (debugCollector) {
        this.view.renderDebugReport(
          renderDebugReport(
            {
              modelAlias: this.sessionContext.activeModelAlias,
              providerName: this.settings.llm.models[this.sessionContext.activeModelAlias]?.provider ?? "unbekannt",
              providerModelId: this.settings.llm.models[this.sessionContext.activeModelAlias]?.model ?? "unbekannt",
              promptSegments: [
                {
                  label: "Sleep-Systemprompt",
                  role: "system",
                  content: sleepMessages[0]?.content ?? "",
                },
                { label: "Sleep-User-Snapshot", role: "user", content: sleepMessages[1]?.content ?? snapshot },
              ],
              shortTerm: shortTermDebug,
              midTerm: {
                tier: "midTerm",
                query: quiet ? "sleepquiet" : "sleep",
                retrievalMode: "empty",
                embeddingAttempted: debugCollector.snapshot().embeddings.some(
                  (event) => event.purpose === "memory_store_sleep" && event.tier === "midTerm",
                ),
                embeddingSucceeded: debugCollector.snapshot().embeddings.some(
                  (event) =>
                    event.purpose === "memory_store_sleep" &&
                    event.tier === "midTerm" &&
                    event.success,
                ),
                usedEntries: [],
                text: `Gespeicherte Fragmente: ${storedMidTermFragments.map((fragment) => fragment.title).join(" | ") || "(keine)"}`,
              },
              longTerm: {
                tier: "longTerm",
                query: quiet ? "sleepquiet" : "sleep",
                retrievalMode: "empty",
                embeddingAttempted: debugCollector.snapshot().embeddings.some(
                  (event) => event.purpose === "memory_store_sleep" && event.tier === "longTerm",
                ),
                embeddingSucceeded: debugCollector.snapshot().embeddings.some(
                  (event) =>
                    event.purpose === "memory_store_sleep" &&
                    event.tier === "longTerm" &&
                    event.success,
                ),
                usedEntries: [],
                text: `Gespeicherte Fragmente: ${storedLongTermFragments.map((fragment) => fragment.title).join(" | ") || "(keine)"}`,
              },
            },
            debugCollector.snapshot(),
          ),
        );
      }

      if (quiet) {
        const createdCount = storedFragments.filter((fragment) => fragment.action === "created").length;
        const updatedCount = storedFragments.filter((fragment) => fragment.action === "updated").length;
        this.view.appendMessage(
          "sys>",
          `Sleep abgeschlossen. ${storedFragments.length} Fragmente gespeichert (${createdCount} neu, ${updatedCount} aktualisiert; MTM ${storedMidTermFragments.length}, LTM ${storedLongTermFragments.length}).`,
        );
        return;
      }

      if (storedFragments.length === 0) {
        this.view.appendMessage("sys>", "Sleep abgeschlossen. Keine relevanten Mid-/Long-Term-Fragmente gespeichert.");
        return;
      }

      this.view.appendMessage(
        "sys>",
        this.summarizeStoredFragments("Sleep abgeschlossen", storedMidTermFragments, storedLongTermFragments),
      );
    } catch (error) {
      this.view.clearTransientStatus();
      const message =
        error instanceof InferenceError || error instanceof Error
          ? error.message
          : "Unbekannter Fehler bei /sleep.";
      this.memoryRepository.recordMemoryFeedback(this.settings, {
        createdAt: new Date().toISOString(),
        scope: quiet ? "sleepquiet" : "sleep",
        outcome: "failure",
        message,
      });
      this.view.appendMessage("sys>", `Sleep fehlgeschlagen: ${message}`);
    } finally {
      if (this.activeExecution?.controller === execution.controller) {
        this.activeExecution = null;
      }
    }
  }

  private dedupeFeedbackEntries(entries: MemoryFeedbackEntry[]): MemoryFeedbackEntry[] {
    const seen = new Set<string>();
    const deduped: MemoryFeedbackEntry[] = [];

    for (const entry of entries) {
      const normalizedMessage = entry.message.trim();
      if (normalizedMessage.length === 0) {
        continue;
      }
      const key = `${entry.scope}:${entry.outcome}:${normalizedMessage.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push({
        ...entry,
        message: normalizedMessage,
      });
    }

    return deduped.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private collectFailureFeedback(): MemoryFeedbackEntry[] {
    const persistedFeedback = this.memoryRepository.loadMemoryFeedback(this.settings);
    const persistedEntries = this.memoryRepository.loadPersistedShortTermEntries(this.settings);
    const extracted = extractFailureFeedbackFromShortTermEntries([
      ...persistedEntries,
      ...this.sessionContext.sessionEvents,
    ]);
    return this.dedupeFeedbackEntries([...persistedFeedback, ...extracted]);
  }

  private summarizeStoredFragments(
    prefix: string,
    midTermFragments: Array<{ title: string; action: "created" | "updated" }>,
    longTermFragments: Array<{ title: string; action: "created" | "updated" }>,
  ): string {
    const combined = [...midTermFragments, ...longTermFragments];
    if (combined.length === 0) {
      return `${prefix}. Keine relevanten Mid-/Long-Term-Fragmente gespeichert.`;
    }

    return `${prefix}. MTM ${midTermFragments.length}, LTM ${longTermFragments.length}: ${combined
      .map((fragment) => `${fragment.title} [${fragment.action === "created" ? "neu" : "aktualisiert"}]`)
      .join(" | ")}`;
  }

  private async handleMemoryRoundupCommand(): Promise<void> {
    if (this.activeExecution) {
      this.view.appendMessage("sys>", `Bereits aktiv: ${this.activeExecution.label}. Esc bricht die laufende Ausfuehrung ab.`);
      return;
    }

    const [midTermFragments, longTermFragments] = await Promise.all([
      this.memoryRepository.loadMidTermMemoryFragments(this.settings),
      this.memoryRepository.loadLongTermMemoryFragments(this.settings),
    ]);
    const failureFeedback = this.collectFailureFeedback();
    if (midTermFragments.length === 0 && longTermFragments.length === 0 && failureFeedback.length === 0) {
      this.view.appendMessage("sys>", "Memory-Roundup beendet. Kein persistiertes Memory oder Feedback vorhanden.");
      return;
    }

    const debugCollector = this.sessionContext.debugEnabled ? new DebugCollector() : undefined;
    const roundupMessages = buildMemoryRoundupMessages(
      midTermFragments,
      longTermFragments,
      this.memoryRepository.loadMemoryFeedback(this.settings),
      failureFeedback,
    );
    this.view.setTransientStatus("Persistentes Memory wird ueberarbeitet", "request");
    const execution = {
      controller: new AbortController(),
      label: "Memoryroundup",
    };
    this.activeExecution = execution;

    try {
      const result = await this.inferenceClient.createChatCompletion(
        this.settings,
        this.sessionContext.activeModelAlias,
        roundupMessages,
        debugCollector,
        {
          purpose: "memory_roundup",
          scope: "memoryroundup",
        },
        undefined,
        execution.controller.signal,
      );
      this.ensureExecutionNotAborted(execution.controller);
      this.sessionContext.recordUsage(result.usage);
      const parsed = parseMemoryRoundupResponse(
        result.text,
        Math.max(
          this.settings.memory.midTerm.maxFragmentsPerSleep,
          this.settings.memory.longTerm.maxFragmentsPerSleep,
        ) * 2,
      );
      const merged = mergeConsolidationFragments(parsed);
      const storedMidTermFragments = await this.memoryRepository.replaceMidTermMemoryFragments(
        this.settings,
        merged.midTermFragments,
        debugCollector,
      );
      const storedLongTermFragments = await this.memoryRepository.replaceLongTermMemoryFragments(
        this.settings,
        merged.longTermFragments,
        debugCollector,
      );

      this.view.clearTransientStatus();
      this.view.appendMessage(
        "sys>",
        this.summarizeStoredFragments("Memory-Roundup abgeschlossen", storedMidTermFragments, storedLongTermFragments),
      );
    } catch (error) {
      this.view.clearTransientStatus();
      const message =
        error instanceof InferenceError || error instanceof Error
          ? error.message
          : "Unbekannter Fehler bei /memoryroundup.";
      this.memoryRepository.recordMemoryFeedback(this.settings, {
        createdAt: new Date().toISOString(),
        scope: "memoryroundup",
        outcome: "failure",
        message,
      });
      this.view.appendMessage("sys>", `Memory-Roundup fehlgeschlagen: ${message}`);
    } finally {
      if (this.activeExecution?.controller === execution.controller) {
        this.activeExecution = null;
      }
    }
  }

  private async handleChatPrompt(value: string): Promise<void> {
    const startedAt = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let sawUsage = false;
    const correctionCounts = {
      invalidJson: 0,
      missingTool: 0,
    };

    this.view.setTransientStatus(`${this.sessionContext.activeModelAlias} antwortet`, "request");
    const execution = {
      controller: new AbortController(),
      label: "Anfrage",
    };
    this.activeExecution = execution;

    try {
      const debugCollector = this.sessionContext.debugEnabled ? new DebugCollector() : undefined;
      const contextEvents = this.sessionContext.sessionEvents;
      this.sessionContext.pushEvent({
        role: "user",
        kind: "message",
        content: value,
      });
      const { messages: conversation, debug: requestDebug } =
        await this.contextBuilder.buildRequestConversation(
          value,
          this.sessionContext.activeModelAlias,
          contextEvents,
          debugCollector,
        );
      this.ensureExecutionNotAborted(execution.controller);
      let finalText: string | null = null;
      let roundtripCount = 0;
      let sawToolCall = false;
      let toolExecutionCount = 0;

      const flushCorrectionSummary = (): void => {
        const parts: string[] = [];
        if (correctionCounts.invalidJson > 0) {
          parts.push(`Formatkorrektur ${correctionCounts.invalidJson}x`);
        }
        if (correctionCounts.missingTool > 0) {
          parts.push(`Tool-Nachforderung ${correctionCounts.missingTool}x`);
        }
        if (parts.length > 0) {
          this.view.appendMessage("sys>", `Loop-Korrektur: ${parts.join(" | ")}`);
        }
      };

      while (finalText === null) {
        this.view.setTransientStatus(`${this.sessionContext.activeModelAlias} antwortet`, "request");
        this.sessionContext.pushEvent({
          role: "system",
          kind: "model_request",
          includeInPrompt: false,
          content: `Model-Request Roundtrip ${roundtripCount + 1} an ${this.sessionContext.activeModelAlias}.`,
          metadata: {
            roundtrip: roundtripCount + 1,
            modelAlias: this.sessionContext.activeModelAlias,
            ...this.sessionContext.snapshotMessages(conversation),
            ...(roundtripCount === 0
              ? { promptSegments: requestDebug.promptSegments.map((segment) => ({ ...segment })) }
              : {}),
          },
        });
        let streamedResponseIndex: number | null = null;
        let streamedReasoningIndex: number | null = null;
        let streamedResponseText = "";
        let streamedReasoningText = "";
        const streamCallbacks: ChatCompletionStreamCallbacks = {
          onTextDelta: (delta) => {
            streamedResponseText += delta;
            if (streamedResponseIndex === null) {
              streamedResponseIndex = this.view.appendMessage("agent>", delta);
              return;
            }
            this.view.appendToMessage(streamedResponseIndex, delta);
          },
          onReasoningDelta: (delta) => {
            streamedReasoningText += delta;
            if (streamedReasoningIndex === null) {
              streamedReasoningIndex = this.view.appendMessage("think>", delta, "reasoning");
              return;
            }
            this.view.appendToMessage(streamedReasoningIndex, delta);
          },
        };
        const result = await this.inferenceClient.createChatCompletion(
          this.settings,
          this.sessionContext.activeModelAlias,
          conversation,
          debugCollector,
          {
            purpose: "request_loop",
            scope: `roundtrip_${roundtripCount + 1}`,
          },
          streamCallbacks,
          execution.controller.signal,
        );
        this.ensureExecutionNotAborted(execution.controller);
        this.sessionContext.recordUsage(result.usage);
        this.sessionContext.pushEvent({
          role: "assistant",
          kind: "model_response",
          includeInPrompt: false,
          content: `Model-Antwort Roundtrip ${roundtripCount + 1} empfangen.`,
          metadata: {
            roundtrip: roundtripCount + 1,
            modelAlias: result.modelAlias,
            providerName: result.providerName,
            providerModelId: result.providerModelId,
            text: result.text,
            reasoning: result.reasoning,
            usage: result.usage,
            requestBody: result.requestBody,
            rawResponse: result.rawResponse,
          },
        });
        if (result.reasoning.length > 0 || streamedReasoningText.trim().length > 0) {
          this.sessionContext.pushEvent({
            role: "assistant",
            kind: "reasoning",
            includeInPrompt: true,
            content: result.reasoning.length > 0 ? result.reasoning : streamedReasoningText.trim(),
            metadata: {
              roundtrip: roundtripCount + 1,
              modelAlias: result.modelAlias,
            },
          });
        }
        if (result.usage.inputTokens !== null) {
          totalInputTokens += result.usage.inputTokens;
          sawUsage = true;
        }
        if (result.usage.outputTokens !== null) {
          totalOutputTokens += result.usage.outputTokens;
          sawUsage = true;
        }

        conversation.push({
          role: "assistant",
          content: result.text,
        });

        if (!this.settings.tools.enabled) {
          finalText = result.text;
          break;
        }

        const parsedResponse = parseAssistantToolResponse(result.text);
        if (!parsedResponse) {
          if (streamedResponseIndex !== null) {
            this.view.updateMessage(streamedResponseIndex, {
              prefix: "sys>",
              message: [
                "Ungueltige Modellantwort erhalten. Die Rohantwort wurde verworfen.",
                streamedResponseText.trim(),
              ]
                .filter((part) => part.length > 0)
                .join("\n\n"),
            });
          }
          roundtripCount += 1;
          if (roundtripCount > this.settings.tools.maxRoundtrips) {
            throw new InferenceError(`Maximale Tool-Roundtrips erreicht (${this.settings.tools.maxRoundtrips}).`);
          }

          conversation.push({
            role: "user",
            content: [
              "Deine letzte Antwort war ungueltig.",
              "Antworte jetzt ausschliesslich mit genau einem JSON-Objekt im vereinbarten Format.",
              "Wenn ein Tool zur Loesung beitragen kann, liefere einen tool_call. Andernfalls liefere final.",
            ].join("\n"),
          });
          this.sessionContext.pushEvent({
            role: "system",
            kind: "loop_correction",
            includeInPrompt: true,
            content: "Ungueltige Modellantwort. JSON-Antwort wurde nachgefordert.",
            metadata: {
              roundtrip: roundtripCount,
              rawAssistantText: result.text,
            },
          });
          correctionCounts.invalidJson += 1;
          this.view.setTransientStatus("Antwortformat wird korrigiert", "request");
          continue;
        }

        if (parsedResponse.type === "final") {
          if (!sawToolCall) {
            if (streamedResponseIndex !== null) {
              this.view.updateMessage(streamedResponseIndex, {
                prefix: "sys>",
                message: "Final-Antwort ohne vorherige Tool-Nutzung erhalten. Es wird ein Tool-Call nachgefordert.",
              });
            }
            roundtripCount += 1;
            if (roundtripCount > this.settings.tools.maxRoundtrips) {
              throw new InferenceError(`Maximale Tool-Roundtrips erreicht (${this.settings.tools.maxRoundtrips}).`);
            }

            conversation.push({
              role: "user",
              content: [
                "Deine letzte Antwort war ungueltig.",
                "Bei dieser Nutzeranfrage musst du vor der finalen Antwort mindestens ein registriertes Tool verwenden.",
                "Antworte jetzt mit genau einem JSON-Objekt vom Typ tool_call.",
              ].join("\n"),
            });
            this.sessionContext.pushEvent({
              role: "system",
              kind: "loop_correction",
              includeInPrompt: true,
              content: "Final-Antwort ohne Tool. Tool-Call wurde nachgefordert.",
              metadata: {
                roundtrip: roundtripCount,
                rawAssistantText: result.text,
              },
            });
            correctionCounts.missingTool += 1;
            this.view.setTransientStatus("Tool-Nutzung wird nachgefordert", "request");
            continue;
          }

          if (streamedResponseIndex !== null) {
            this.view.updateMessage(streamedResponseIndex, {
              prefix: "agent>",
              message: parsedResponse.message,
            });
          }
          finalText = parsedResponse.message;
          break;
        }

        roundtripCount += 1;
        if (roundtripCount > this.settings.tools.maxRoundtrips) {
          throw new InferenceError(`Maximale Tool-Roundtrips erreicht (${this.settings.tools.maxRoundtrips}).`);
        }

        sawToolCall = true;
        toolExecutionCount += 1;
        this.sessionContext.pushEvent({
          role: "tool",
          kind: "tool_call",
          includeInPrompt: true,
          content: `Tool-Call ${toolExecutionCount}: ${parsedResponse.call.tool}`,
          metadata: {
            roundtrip: roundtripCount,
            tool: parsedResponse.call.tool,
            arguments: parsedResponse.call.arguments ?? null,
          },
        });
        this.view.setTransientStatus(`Tool ${toolExecutionCount}: ${parsedResponse.call.tool} laeuft`, "tool");
        if (streamedResponseIndex !== null) {
          this.view.updateMessage(streamedResponseIndex, {
            prefix: "sys>",
            message: `Tool-Call ${toolExecutionCount}: ${parsedResponse.call.tool}`,
          });
        }

        let toolResultText: string;
        let toolSummary: string;
        let streamedToolIndex: number | null = null;
        let toolSucceeded = false;

        try {
          const toolResult = await this.toolExecutor.execute(
            this.settings,
            parsedResponse.call,
            debugCollector,
            {
              onUpdate: (chunk) => {
                if (streamedToolIndex === null) {
                  streamedToolIndex = this.view.appendMessage("tool>", chunk);
                  return;
                }
                this.view.appendToMessage(streamedToolIndex, chunk);
              },
            },
            {
              signal: execution.controller.signal,
            },
          );
          this.ensureExecutionNotAborted(execution.controller);

          if (toolResult.ok && toolResult.tool === "create_typescript_file") {
            const createdPath = typeof toolResult.output.path === "string" ? toolResult.output.path : "";
            const createdDescription =
              typeof toolResult.output.description === "string" ? toolResult.output.description : "";
            if (createdPath.length > 0) {
              this.sessionContext.createdScripts.set(createdPath, {
                description: createdDescription,
                publishedAfterSuccessfulRun: false,
              });
            }
          }

          if (toolResult.ok && toolResult.tool === "run_typescript_file") {
            const scriptPath = typeof toolResult.output.path === "string" ? toolResult.output.path : "";
            const normalizedArgs = Array.isArray(toolResult.output.args)
              ? toolResult.output.args.filter((entry): entry is string => typeof entry === "string")
              : [];

            if (scriptPath.length > 0) {
              const publication = await this.publishCreatedScriptAfterSuccessfulRun(
                scriptPath,
                JSON.stringify(toolResult, null, 2),
                normalizedArgs,
                debugCollector,
              );

              if (publication.registryPublished) {
                toolResult.output.registryPublished = true;
                toolResult.output.registryEmbeddingUsed = publication.registryEmbeddingUsed;
                toolResult.output.midTermMemoryStored = publication.midTermStored;
                if (publication.title) {
                  toolResult.output.midTermTitle = publication.title;
                }
              }
            }
          }

          toolResultText = JSON.stringify(toolResult, null, 2);
          toolSummary = toolResult.summary;
          toolSucceeded = toolResult.ok;
          this.view.appendMessage("tool>", `Tool ${toolExecutionCount}: ${toolSummary}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unbekannter Fehler bei der Tool-Ausfuehrung.";
          toolSummary = "Tool-Ausfuehrung fehlgeschlagen.";
          toolResultText = JSON.stringify(
            {
              ok: false,
              tool: parsedResponse.call.tool,
              summary: toolSummary,
              output: {
                error: message,
              },
            },
            null,
            2,
          );
          this.memoryRepository.recordMemoryFeedback(this.settings, {
            createdAt: new Date().toISOString(),
            scope: "tool",
            outcome: "failure",
            message: `${parsedResponse.call.tool}: ${message}`,
          });
          this.view.clearTransientStatus();
          this.view.appendMessage("tool>", `Tool ${toolExecutionCount}: Fehler: ${message}`);
        }

        this.sessionContext.pushEvent({
          role: "tool",
          kind: "tool_result",
          includeInPrompt: true,
          content: `Tool ${parsedResponse.call.tool}: ${toolSummary}`,
          metadata: {
            roundtrip: roundtripCount,
            tool: parsedResponse.call.tool,
            success: toolSucceeded,
            result: JSON.parse(toolResultText) as Record<string, unknown>,
          },
        });

        conversation.push({
          role: "user",
          content: [
            `Tool-Ergebnis fuer ${parsedResponse.call.tool}:`,
            toolResultText,
            "Analysiere dieses Ergebnis und antworte entweder mit dem naechsten Tool-Call oder mit final.",
          ].join("\n"),
        });
      }

      if (finalText === null) {
        throw new InferenceError("Agent-Loop wurde ohne finale Antwort beendet.");
      }

      this.sessionContext.pushEvent({
        role: "assistant",
        kind: "message",
        content: finalText,
      });

      this.view.clearTransientStatus();
      flushCorrectionSummary();
      if (debugCollector) {
        this.view.renderDebugReport(renderDebugReport(requestDebug, debugCollector.snapshot()));
      }
      if (!this.settings.tools.enabled) {
        this.view.appendMessage("agent>", finalText);
      }
      this.view.appendMessage(
        "sys>",
        `Zeit: ${formatDuration(Date.now() - startedAt)} | in: ${formatTokenCount(sawUsage ? totalInputTokens : null)} | out: ${formatTokenCount(sawUsage ? totalOutputTokens : null)}`,
      );
    } catch (error) {
      this.view.clearTransientStatus();
      const message =
        error instanceof InferenceError || error instanceof Error
          ? error.message
          : "Unbekannter Fehler bei der Inference.";

      this.sessionContext.pushEvent({
        role: "system",
        kind: "status",
        includeInPrompt: true,
        content: `Anfrage fehlgeschlagen: ${message}`,
        metadata: {
          modelAlias: this.sessionContext.activeModelAlias,
          success: false,
        },
      });
      this.memoryRepository.recordMemoryFeedback(this.settings, {
        createdAt: new Date().toISOString(),
        scope: "request",
        outcome: "failure",
        message,
      });
      this.view.appendMessage("sys>", message);
    } finally {
      if (this.activeExecution?.controller === execution.controller) {
        this.activeExecution = null;
      }
    }
  }

  private async publishCreatedScriptAfterSuccessfulRun(
    absoluteScriptPath: string,
    toolResultText: string,
    normalizedArgs: string[],
    debugCollector?: DebugCollector,
  ): Promise<{
    registryPublished: boolean;
    registryEmbeddingUsed: boolean;
    midTermStored: boolean;
    title?: string;
  }> {
    const createdScript = this.sessionContext.createdScripts.get(absoluteScriptPath);
    if (!createdScript || createdScript.publishedAfterSuccessfulRun) {
      return {
        registryPublished: false,
        registryEmbeddingUsed: false,
        midTermStored: false,
      };
    }

    const fallbackDescription =
      createdScript.description.trim().length > 0
        ? createdScript.description.trim()
        : `Hilfsskript ${basename(absoluteScriptPath)}`;
    const fallbackUsage = `run_typescript_file mit path "${absoluteScriptPath}" und args ${JSON.stringify(normalizedArgs)}`;

    let knowledge: ScriptKnowledgeResponse;
    try {
      const result = await this.inferenceClient.createChatCompletion(
        this.settings,
        this.sessionContext.activeModelAlias,
        buildScriptKnowledgeMessages(
          absoluteScriptPath,
          fallbackDescription,
          fallbackUsage,
          toolResultText,
        ),
        debugCollector,
        {
          purpose: "script_knowledge",
          scope: absoluteScriptPath,
        },
      );
      this.sessionContext.recordUsage(result.usage);
      knowledge = parseScriptKnowledgeResponse(
        result.text,
        fallbackDescription,
        fallbackUsage,
        absoluteScriptPath,
      );
    } catch {
      knowledge = {
        description: fallbackDescription,
        usage: fallbackUsage,
        midTermTitle: `Tool ${basename(absoluteScriptPath)}`,
        midTermContent: `Skript ${absoluteScriptPath} wurde erfolgreich ausgefuehrt.\nNutzen: ${fallbackDescription}\nUsage: ${fallbackUsage}`,
      };
    }

    const publication = await this.scriptRegistryRepository.publish(
      this.settings,
      absoluteScriptPath,
      knowledge.description,
      knowledge.usage,
      debugCollector,
    );
    const storedFragments = await this.memoryRepository.storeMidTermMemoryFragments(
      this.settings,
      [
        {
          title: knowledge.midTermTitle,
          content: knowledge.midTermContent,
        },
      ],
      debugCollector,
    );

    this.sessionContext.createdScripts.set(absoluteScriptPath, {
      ...createdScript,
      publishedAfterSuccessfulRun: true,
    });

    return {
      registryPublished: true,
      registryEmbeddingUsed: publication.embeddingUsed,
      midTermStored: storedFragments.length > 0,
      title: knowledge.midTermTitle,
    };
  }
}
