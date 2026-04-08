import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, extname, resolve } from "node:path";
import type {
  AgentToolDefinition,
  ToolExecutionCallbacks,
  ToolExecutionContext,
  ToolResult,
} from "../types";
import { resolveScriptPath } from "../path";

const TSX_CLI_PATH = resolve(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

function normalizeArgs(args: unknown): string[] {
  if (args === undefined) {
    return [];
  }

  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new Error("Argument 'args' muss ein Array aus Strings sein.");
  }

  return [...args];
}

export class RunTypescriptFileTool implements AgentToolDefinition {
  readonly name = "run_typescript_file";
  readonly prompt =
    "Fuehrt eine vorhandene TypeScript-Datei aus tools.scriptsDir mit tsx aus. Verwende es, nachdem du ein Hilfsskript erzeugt, angepasst oder in der Registry gefunden hast, um echten Output, Fehlertexte oder Berechnungsergebnisse zu erhalten. Ein erzeugtes Skript soll nicht nur beschrieben, sondern bei passender Aufgabe auch tatsaechlich benutzt werden. Uebergib vorhandene Parameter ueber `args`, statt Werte im Skript fest einzubauen. Argumente: {\"path\":\"relativ/zur/datei.ts\",\"args\":[\"...\"]}.";

  async execute(
    settings: Parameters<AgentToolDefinition["execute"]>[0],
    args: unknown,
    _debugCollector?: Parameters<AgentToolDefinition["execute"]>[2],
    callbacks?: ToolExecutionCallbacks,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error("Argumente fuer run_typescript_file muessen ein Objekt sein.");
    }

    const { args: scriptArgs, path } = args as {
      args?: unknown;
      path?: unknown;
    };

    mkdirSync(settings.tools.scriptsDir, { recursive: true });
    const absolutePath = resolveScriptPath(settings, path);

    if (extname(absolutePath) !== ".ts") {
      throw new Error("Es sind nur TypeScript-Dateien mit Endung '.ts' erlaubt.");
    }

    if (!existsSync(absolutePath)) {
      throw new Error(`Datei existiert nicht: ${absolutePath}`);
    }

    if (!existsSync(TSX_CLI_PATH)) {
      throw new Error(`tsx CLI nicht gefunden: ${TSX_CLI_PATH}`);
    }

    const normalizedArgs = normalizeArgs(scriptArgs);

    if (context?.signal?.aborted) {
      throw new Error("Tool-Ausfuehrung wurde abgebrochen.");
    }

    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
      stdout: string;
      timedOut: boolean;
    }>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [TSX_CLI_PATH, absolutePath, ...normalizedArgs], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, settings.tools.executionTimeoutMs);

      const abortHandler = (): void => {
        aborted = true;
        child.kill("SIGTERM");
      };

      context?.signal?.addEventListener("abort", abortHandler, { once: true });

      child.stdout.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        stdout += text;
        callbacks?.onUpdate?.(`[stdout] ${text}`);
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        stderr += text;
        callbacks?.onUpdate?.(`[stderr] ${text}`);
      });

      child.once("error", (error) => {
        clearTimeout(timeout);
        context?.signal?.removeEventListener("abort", abortHandler);
        rejectPromise(error);
      });

      child.once("close", (exitCode, signal) => {
        clearTimeout(timeout);
        context?.signal?.removeEventListener("abort", abortHandler);
        resolvePromise({
          exitCode,
          signal: aborted ? "SIGTERM" : signal,
          stderr: stderr.trim(),
          stdout: stdout.trim(),
          timedOut: aborted ? false : timedOut,
        });
      });
    });

    if (context?.signal?.aborted) {
      throw new Error("Tool-Ausfuehrung wurde abgebrochen.");
    }

    const ok = result.exitCode === 0 && !result.timedOut;

    return {
      ok,
      tool: this.name,
      summary: ok
        ? `TypeScript-Datei erfolgreich ausgefuehrt: ${basename(absolutePath)}`
        : `Ausfuehrung fehlgeschlagen: ${basename(absolutePath)}`,
      output: {
        path: absolutePath,
        args: normalizedArgs,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  }
}

export const runTypescriptFileTool: AgentToolDefinition = new RunTypescriptFileTool();
