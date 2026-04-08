import type { ChatMessage, TokenParameterName } from "../../inference";
import type { ModelConfig } from "../../settings";

export class RequestBodyFactory {
  buildRequestBody(
    modelConfig: ModelConfig,
    messages: ChatMessage[],
    tokenParameterName: TokenParameterName,
    enableStreaming = false,
  ): Record<string, unknown> {
    return {
      model: modelConfig.model,
      messages,
      temperature: modelConfig.temperature,
      [tokenParameterName]: modelConfig.maxTokens,
      ...(enableStreaming
        ? {
            stream: true,
            stream_options: {
              include_usage: true,
            },
          }
        : {}),
    };
  }
}

