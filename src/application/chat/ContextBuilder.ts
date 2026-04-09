import { DebugCollector } from "../../debug";
import type { BuildConversationResult, PromptDebugSegment, RequestDebugInfo } from "../../domain/chatTypes";
import type { IAgentModuleService, IMemoryRepository } from "../../domain/ports";
import type { ChatMessage } from "../../inference";
import type { AppSettings } from "../../settings";
import { buildToolSystemPrompt } from "../../tools/index";
import type { ShortTermConversationEntry, ToolRoutingLearning } from "../../memory";
import type { AgentModuleDiscoveryEntry } from "../../modules";

function formatRunningModulePrompt(entry: AgentModuleDiscoveryEntry, includeDetails: boolean): string {
  const prompt = entry.handshake?.agentPrompt?.trim() || entry.manifest?.agentPrompt?.trim();
  const lines = [`[${entry.name}] ${entry.summary}`];

  if (entry.status !== "running") {
    lines[0] = `${lines[0]} (derzeit nicht gestartet, kann aber bei Bedarf ueber Tool-Aufruf gestartet werden)`;
  }

  if (prompt) {
    lines.push(`Prompt: ${prompt}`);
  }

  if (includeDetails) {
    const capabilitySummary = entry.capabilities
      .map((capability) => `${capability.action}: ${capability.description}`)
      .join(" | ");
    if (capabilitySummary.length > 0) {
      lines.push(`Capabilities: ${capabilitySummary}`);
    }
  }

  return lines.join("\n");
}

function dedupeToolRoutingLearnings(learnings: ToolRoutingLearning[]): ToolRoutingLearning[] {
  const deduped = new Map<string, ToolRoutingLearning>();

  for (const learning of learnings) {
    const key = [
      learning.requestPattern,
      learning.preferredTools.join(","),
      learning.preferredScripts.join(","),
      learning.preferredModules.join(","),
      learning.avoidDiscoveryTools.join(","),
      learning.fallback,
    ].join("::");
    if (!deduped.has(key)) {
      deduped.set(key, learning);
    }
  }

  return [...deduped.values()];
}

function formatToolRoutingPrompt(learnings: ToolRoutingLearning[]): string {
  if (learnings.length === 0) {
    return "";
  }

  return [
    "Kompakte Tool-Routing-Hinweise aus dem Memory. Bevorzuge direkte, produktive und tokenarme Tool-Pfade. Generische Discovery nur dann, wenn ein bevorzugter Kandidat fehlschlaegt oder leer zurueckkommt.",
    ...learnings.slice(0, 4).map((learning, index) => {
      const preferred = [
        ...learning.preferredTools,
        ...learning.preferredScripts,
        ...learning.preferredModules,
      ].join(" -> ");
      const avoided = learning.avoidDiscoveryTools.length > 0
        ? learning.avoidDiscoveryTools.join(", ")
        : "keine";
      const rationale = learning.rationale.length > 0 ? ` | warum: ${learning.rationale}` : "";
      return `${index + 1}. Anfragebild: ${learning.requestPattern} | zuerst: ${preferred} | Discovery zunaechst meiden: ${avoided} | Fallback: ${learning.fallback}${rationale}`;
    }),
  ].join("\n");
}

export class ContextBuilder {
  constructor(
    private readonly settings: AppSettings,
    private readonly memoryRepository: IMemoryRepository,
    private readonly agentModuleService?: IAgentModuleService,
  ) {}

  buildBaseConversation(): { messages: ChatMessage[]; promptSegments: PromptDebugSegment[] } {
    const promptSegments: PromptDebugSegment[] = [
      {
        label: "Systemprompt",
        role: "system",
        content: this.settings.llm.systemPrompt,
      },
    ];
    const toolPrompt = buildToolSystemPrompt(this.settings);

    if (toolPrompt.length > 0) {
      promptSegments.push({
        label: "Tool-Systemprompt",
        role: "system",
        content: toolPrompt,
      });
    }

    const promptEntries = this.collectModulePromptEntries();

    if (promptEntries.length > 0) {
      const modulePrompt = [
        "Beruecksichtige die folgenden Regeln aus verfuegbaren Agent-Modulen. Laufende Module sind sofort nutzbar; installierte, noch nicht laufende Module koennen bei Bedarf ueber die Modul-Tools verwendet oder automatisch gestartet werden.",
        ...promptEntries.map((entry) =>
          formatRunningModulePrompt(entry, this.settings.modules.includeModuleDetailsInPrompt),
        ),
      ].join("\n\n");

      promptSegments.push({
        label: "Aktive Modul-Prompts",
        role: "system",
        content: modulePrompt,
      });
    }

    return {
      messages: [
        {
          role: "system",
          content: promptSegments.map((segment) => segment.content).join("\n\n"),
        },
      ],
      promptSegments,
    };
  }

  private collectModulePromptEntries(): AgentModuleDiscoveryEntry[] {
    const runningByName = new Map(
      (this.agentModuleService?.listRunningModules(this.settings) ?? []).map((entry) => [entry.name, entry] as const),
    );
    const discovered = this.agentModuleService?.discover(this.settings, { includeDetails: true }) ?? [];
    const merged = new Map<string, AgentModuleDiscoveryEntry>();

    for (const entry of discovered) {
      const prompt = entry.handshake?.agentPrompt?.trim() || entry.manifest?.agentPrompt?.trim();
      if (typeof prompt !== "string" || prompt.length === 0 || entry.enabled !== true) {
        continue;
      }

      merged.set(entry.name, runningByName.get(entry.name) ?? entry);
    }

    return [...merged.values()]
      .sort((left, right) => {
        if (left.status === "running" && right.status !== "running") {
          return -1;
        }
        if (left.status !== "running" && right.status === "running") {
          return 1;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, this.settings.modules.maxPromptModules);
  }

  async buildContextOverview(
    query: string,
    activeModelAlias: string,
    contextEvents: ShortTermConversationEntry[],
    debugCollector?: DebugCollector,
  ): Promise<BuildConversationResult> {
    const { messages: conversation, promptSegments } = this.buildBaseConversation();
    const longTermContext = await this.memoryRepository.loadLongTermMemoryContextWithDebug(
      this.settings,
      query,
      debugCollector,
    );
    const midTermContext = await this.memoryRepository.loadMidTermMemoryContextWithDebug(
      this.settings,
      query,
      debugCollector,
    );
    const shortTermContext = this.memoryRepository.loadShortTermMemorySnapshotWithDebug(
      this.settings,
      contextEvents,
    );
    const toolRoutingLearnings = dedupeToolRoutingLearnings([
      ...longTermContext.debug.routingLearnings,
      ...midTermContext.debug.routingLearnings,
    ]);
    const modelConfig = this.settings.llm.models[activeModelAlias];

    if (!modelConfig) {
      throw new Error(`Unbekanntes Modell-Alias: ${activeModelAlias}`);
    }

    if (longTermContext.text.length > 0) {
      conversation.push({
        role: "system",
        content: longTermContext.text,
      });
      promptSegments.push({
        label: "Long-Term-Memory",
        role: "system",
        content: longTermContext.text,
      });
    }

    if (midTermContext.text.length > 0) {
      conversation.push({
        role: "system",
        content: midTermContext.text,
      });
      promptSegments.push({
        label: "Mid-Term-Memory",
        role: "system",
        content: midTermContext.text,
      });
    }

    if (shortTermContext.text.length > 0) {
      conversation.push({
        role: "system",
        content: shortTermContext.text,
      });
      promptSegments.push({
        label: "Short-Term-Memory",
        role: "system",
        content: shortTermContext.text,
      });
    }

    const toolRoutingPrompt = formatToolRoutingPrompt(toolRoutingLearnings);
    if (toolRoutingPrompt.length > 0) {
      conversation.push({
        role: "system",
        content: toolRoutingPrompt,
      });
      promptSegments.push({
        label: "Tool-Routing-Hinweise",
        role: "system",
        content: toolRoutingPrompt,
      });
    }

    return {
      messages: conversation,
      promptSegments,
      debug: {
        modelAlias: activeModelAlias,
        providerName: modelConfig.provider,
        providerModelId: modelConfig.model,
        promptSegments,
        shortTerm: shortTermContext.debug,
        midTerm: midTermContext.debug,
        longTerm: longTermContext.debug,
        toolRoutingLearnings,
      },
    };
  }

  async buildRequestConversation(
    userPrompt: string,
    activeModelAlias: string,
    contextEvents: ShortTermConversationEntry[],
    debugCollector?: DebugCollector,
  ): Promise<{ messages: ChatMessage[]; debug: RequestDebugInfo }> {
    const { messages: conversation, promptSegments, debug } = await this.buildContextOverview(
      userPrompt,
      activeModelAlias,
      contextEvents,
      debugCollector,
    );
    conversation.push({
      role: "user",
      content: userPrompt,
    });
    promptSegments.push({
      label: "User",
      role: "user",
      content: userPrompt,
    });

    return {
      messages: conversation,
      debug: {
        ...debug,
        promptSegments,
      },
    };
  }
}
