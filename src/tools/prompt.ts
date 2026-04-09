import type { AppSettings } from "../settings";
import { getRegisteredTools } from "./registry";

export function buildToolSystemPrompt(settings: AppSettings): string {
  if (!settings.tools.enabled) {
    return "";
  }

  return [
    `Du hast Zugriff auf ${getRegisteredTools().length} registrierte Tools.`,
    "Nutze RAG-Kontext und verwende nur reale registrierte Tool-Namen.",
    "Antworte in der Tool-Loop ausschliesslich mit genau einem JSON-Objekt.",
    "Antwortformat:",
    '{"type":"tool_call","tool":"<tool-name>","arguments":{...}}',
    '{"type":"final","message":"<deine finale Antwort an den Nutzer>"}',
    "Regeln:",
    "- Verwende nur genau diese JSON-Objekte ohne Markdown-Codeblock.",
    "- Verwende keinen erfundenen Tool-Namen.",
    "- Wenn ein Tool klar hilft, liefere einen tool_call statt Freitext.",
    "- Wenn die Aufgabe geloest ist oder kein Tool mehr noetig ist, antworte mit type=final.",
  ].join("\n");
}
