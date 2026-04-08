import type { AppSettings } from "../settings";
import { getRegisteredTools } from "./registry";

export function buildToolSystemPrompt(settings: AppSettings): string {
  if (!settings.tools.enabled) {
    return "";
  }

  const registeredTools = getRegisteredTools();
  const toolLines = registeredTools.map(
    (tool) => `- ${tool.name}: ${tool.prompt}`,
  );

  return [
    "Du hast Zugriff auf registrierte Tools.",
    "Bei normalen Nutzeranfragen in dieser Tool-Loop musst du mindestens ein registriertes Tool verwenden, bevor du mit type=final antwortest.",
    "Bevor du ein neues Hilfsskript erzeugst, sollst du zuerst query_script_registry verwenden, um vorhandene Skripte auf Wiederverwendung zu pruefen.",
    "Bevor du ein neues Agent-Modul bootstrappst, sollst du zuerst discover_agent_modules verwenden, um vorhandene Module auf Wiederverwendung oder Erweiterung zu pruefen.",
    "Wenn du ein Hilfsskript erzeugst oder anpasst und es fuer die Aufgabe relevant ist, sollst du es danach auch mit run_typescript_file benutzen, statt nur seine Existenz zu erwaehnen.",
    "Wenn du ein Agent-Modul verwenden willst, nutze discover_agent_modules fuer Auswahl und call_agent_module fuer die eigentliche Interaktion. Start ist bei Bedarf explizit ueber start_agent_module oder implizit ueber call_agent_module moeglich.",
    "Erzeuge neue Hilfsskripte moeglichst so, dass sie ueber Argumente wiederverwendbar sind. Wenn es sinnvoll ist, sollen Eingaben, Filter, Dateipfade, Limits oder Modi als Parameter statt als fest verdrahtete Werte umgesetzt werden.",
    "Behandle Modulfaehigkeiten sparsam. Ziehe Detailinfos nur dann nach, wenn ein bestimmtes Modul fuer die Aufgabe relevant ist.",
    "Wenn der Nutzer eine Aufgabe stellt, die durch lokales Recherchieren, Rechnen, Transformieren, Parsen, Dateierzeugung oder Skriptausfuehrung besser geloest werden kann, sollst du die Tools aktiv verwenden statt nur abstrakt zu beschreiben, was zu tun waere.",
    "Behandle den laufenden Chat als Short-Term-Memory. Long-Term-Memory wird ausschliesslich ueber /sleep oder /sleepquiet verdichtet; es gibt kein Tool fuer direktes persistentes Speichern.",
    "Du musst in der Tool-Loop ausschliesslich mit genau einem JSON-Objekt antworten. Keine Erklaerung davor oder danach.",
    "Antwortformat:",
    '{"type":"tool_call","tool":"<tool-name>","arguments":{...}}',
    '{"type":"final","message":"<deine finale Antwort an den Nutzer>"}',
    "Registrierte Tools:",
    ...toolLines,
    "Regeln:",
    "- Verwende nur genau diese JSON-Objekte ohne Markdown-Codeblock.",
    "- Antworte niemals mit Freitext, solange ein Tool nuetzlich oder angefordert ist.",
    "- Verwende nur registrierte Tool-Namen.",
    "- Bei allen Fragen, die ohne externe Pruefung, Berechnung, Dateizugriff oder aktuelle Daten nicht sicher beantwortbar sind, musst du zuerst ein Tool verwenden und darfst erst danach antworten.",
    "- Lege neue Skripte bevorzugt generisch und parametrisiert an, wenn dadurch spaetere Wiederverwendung realistisch wird.",
    "- Nutze erzeugte oder gefundene Skripte aktiv zur Aufgabenerledigung, wenn ihre Ausfuehrung einen relevanten Zwischenschritt oder das Endergebnis liefert.",
    "- Wenn die Aufgabe geloest ist oder kein Tool mehr noetig ist, antworte mit type=final.",
  ].join("\n");
}
