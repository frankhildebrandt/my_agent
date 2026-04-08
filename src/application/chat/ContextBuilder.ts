import { DebugCollector } from "../../debug";
import type { BuildConversationResult, PromptDebugSegment, RequestDebugInfo } from "../../domain/chatTypes";
import type { IMemoryRepository } from "../../domain/ports";
import type { ChatMessage } from "../../inference";
import type { AppSettings } from "../../settings";
import { buildToolSystemPrompt } from "../../tools";
import type { ShortTermConversationEntry } from "../../memory";

export class ContextBuilder {
  constructor(
    private readonly settings: AppSettings,
    private readonly memoryRepository: IMemoryRepository,
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
