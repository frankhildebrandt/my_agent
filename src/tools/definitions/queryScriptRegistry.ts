import { queryScriptRegistry } from "../../scriptRegistry";
import type { AgentToolDefinition, ToolResult } from "../types";

export class QueryScriptRegistryTool implements AgentToolDefinition {
  readonly name = "query_script_registry";
  readonly prompt =
    "Durchsucht die Script-Registry nach bereits vorhandenen Hilfsskripten. Verwende es vor dem Erzeugen neuer Skripte, um Wiederverwendung zu pruefen oder dir anzeigen zu lassen, welche Skripte bereits existieren. Wenn ein passendes Skript gefunden wird, soll es bevorzugt benutzt oder gezielt angepasst werden, statt vorschnell ein neues Skript zu erzeugen. Nutzt bevorzugt Embedding-Suche ueber Hilfetexte und faellt bei Bedarf auf Textsuche zurueck. Argumente: {\"query\":\"was du suchst\",\"topK\":5}. `query` darf leer sein, um die neuesten Registry-Eintraege zu sehen.";

  async execute(settings: Parameters<AgentToolDefinition["execute"]>[0], args: unknown, debugCollector?: Parameters<AgentToolDefinition["execute"]>[2]): Promise<ToolResult> {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error("Argumente fuer query_script_registry muessen ein Objekt sein.");
    }

    const { query, topK } = args as { query?: unknown; topK?: unknown };
    const normalizedQuery = typeof query === "string" ? query : "";
    const normalizedTopK =
      typeof topK === "number" && Number.isFinite(topK)
        ? Math.trunc(topK)
        : settings.scriptRegistry.topK;
    const matches = await queryScriptRegistry(settings, normalizedQuery, normalizedTopK, debugCollector);

    return {
      ok: true,
      tool: this.name,
      summary:
        matches.length > 0
          ? `${matches.length} Script-Registry-Treffer gefunden.`
          : "Keine passenden Skripte in der Registry gefunden.",
      output: {
        query: normalizedQuery,
        topK: normalizedTopK,
        matches: matches.map((match) => ({
          path: match.path,
          description: match.description,
          usage: match.usage,
          updatedAt: match.updatedAt,
          score: Number(match.score.toFixed(4)),
          scoreSource: match.scoreSource,
        })),
      },
    };
  }
}

export const queryScriptRegistryTool: AgentToolDefinition = new QueryScriptRegistryTool();
