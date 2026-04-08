import type { DebugCollector } from "../debug";
import type { AppSettings } from "../settings";
import { bootstrapAgentModuleTool } from "./definitions/bootstrapAgentModule";
import { callAgentModuleTool } from "./definitions/callAgentModule";
import { CreateTypescriptFileTool, createTypescriptFileTool } from "./definitions/createTypescriptFile";
import { discoverAgentModulesTool } from "./definitions/discoverAgentModules";
import { QueryScriptRegistryTool, queryScriptRegistryTool } from "./definitions/queryScriptRegistry";
import { RunTypescriptFileTool, runTypescriptFileTool } from "./definitions/runTypescriptFile";
import { startAgentModuleTool } from "./definitions/startAgentModule";
import { stopAgentModuleTool } from "./definitions/stopAgentModule";
import type {
  AgentToolDefinition,
  ToolCall,
  ToolExecutionCallbacks,
  ToolExecutionContext,
  ToolResult,
} from "./types";

export class ToolRegistry {
  private readonly registeredTools: AgentToolDefinition[];

  constructor(registeredTools: AgentToolDefinition[] = [
    queryScriptRegistryTool,
    createTypescriptFileTool,
    runTypescriptFileTool,
    discoverAgentModulesTool,
    startAgentModuleTool,
    stopAgentModuleTool,
    callAgentModuleTool,
    bootstrapAgentModuleTool,
  ]) {
    this.registeredTools = [...registeredTools];
  }

  getRegisteredTools(): AgentToolDefinition[] {
    return [...this.registeredTools];
  }

  getRegisteredToolNames(): string[] {
    return this.registeredTools.map((tool) => tool.name);
  }

  getRegisteredTool(name: string): AgentToolDefinition | undefined {
    return this.registeredTools.find((tool) => tool.name === name);
  }
}

export class RegisteredToolExecutor {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  async execute(
    settings: AppSettings,
    toolCall: ToolCall,
    debugCollector?: DebugCollector,
    callbacks?: ToolExecutionCallbacks,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.toolRegistry.getRegisteredTool(toolCall.tool);

    if (!tool) {
      throw new Error(`Unbekanntes Tool: ${String(toolCall.tool)}`);
    }

    return tool.execute(settings, toolCall.arguments, debugCollector, callbacks, context);
  }
}

const defaultToolRegistry = new ToolRegistry();
const defaultToolExecutor = new RegisteredToolExecutor(defaultToolRegistry);

export function getRegisteredTools(): AgentToolDefinition[] {
  return defaultToolRegistry.getRegisteredTools();
}

export function getRegisteredToolNames(): string[] {
  return defaultToolRegistry.getRegisteredToolNames();
}

export function getRegisteredTool(name: string): AgentToolDefinition | undefined {
  return defaultToolRegistry.getRegisteredTool(name);
}

export async function executeRegisteredToolCall(
  settings: AppSettings,
  toolCall: ToolCall,
  debugCollector?: DebugCollector,
  callbacks?: ToolExecutionCallbacks,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  return defaultToolExecutor.execute(settings, toolCall, debugCollector, callbacks, context);
}
