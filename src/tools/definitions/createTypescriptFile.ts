import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { AgentToolDefinition, ToolResult } from "../types";
import { resolveScriptPath } from "../path";

function parseCreateTypescriptFileArgs(args: unknown): ToolResult {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("Argumente fuer create_typescript_file muessen ein Objekt sein.");
  }

  const { content, description, path } = args as {
    content?: unknown;
    description?: unknown;
    path?: unknown;
  };
  if (typeof content !== "string") {
    throw new Error("Argument 'content' muss ein String sein.");
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error("Argument 'description' muss ein nicht-leerer String sein.");
  }

  return {
    ok: true,
    tool: "create_typescript_file",
    summary: "",
    output: {
      content,
      description,
      path,
    },
  };
}

export class CreateTypescriptFileTool implements AgentToolDefinition {
  readonly name = "create_typescript_file";
  readonly prompt =
    "Erzeugt oder ueberschreibt eine TypeScript-Datei unterhalb von tools.scriptsDir. Verwende es, um kleine Hilfsskripte anzulegen, die Daten analysieren, Berechnungen ausfuehren oder lokale Dateien verarbeiten. Neue Skripte sollen moeglichst wiederverwendbar gebaut werden; wenn es fachlich sinnvoll ist, implementiere Eingaben, Filter, Dateipfade, Limits oder Modi als Parameter statt als fest verdrahtete Werte. Wenn das Skript fuer die aktuelle Aufgabe gedacht ist, plane seine anschliessende Ausfuehrung mit run_typescript_file direkt mit ein. Nach einer erfolgreichen Ausfuehrung wird das Skript automatisch in die Script-Registry aufgenommen. Argumente: {\"path\":\"relativ/zur/datei.ts\",\"description\":\"kurzer Hilfetext\",\"content\":\"...typescript...\"}.";

  async execute(settings: Parameters<AgentToolDefinition["execute"]>[0], args: unknown): Promise<ToolResult> {
    const parsed = parseCreateTypescriptFileArgs(args);
    const absolutePath = resolveScriptPath(settings, parsed.output.path);

    if (extname(absolutePath) !== ".ts") {
      throw new Error("Es sind nur TypeScript-Dateien mit Endung '.ts' erlaubt.");
    }

    const content = parsed.output.content;
    if (typeof content !== "string") {
      throw new Error("Argument 'content' muss ein String sein.");
    }
    const description = parsed.output.description;
    if (typeof description !== "string") {
      throw new Error("Argument 'description' muss ein String sein.");
    }

    mkdirSync(settings.tools.scriptsDir, { recursive: true });
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");

    return {
      ok: true,
      tool: this.name,
      summary: `TypeScript-Datei erzeugt: ${absolutePath}`,
      output: {
        path: absolutePath,
        bytes: Buffer.byteLength(content, "utf8"),
        description: description.trim(),
        registryPublished: false,
        registryPublishPendingUntilSuccessfulRun: true,
      },
    };
  }
}

export const createTypescriptFileTool: AgentToolDefinition = new CreateTypescriptFileTool();
