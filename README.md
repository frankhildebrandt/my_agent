# my_agent

Ein selbst erweiternder KI-Agent, geschrieben in TypeScript, um verschiedene Aufgaben auszuführen.

## Einrichtung

1. Stelle sicher, dass Node.js und npm installiert sind.
2. Klone dieses Repository.
3. Installiere die Abhängigkeiten mit `npm install`.
4. Starte die Entwicklungsumgebung mit `npm run dev`.

## Verwendung

Die Anwendung startet jetzt als TUI mit Chat-Eingabe und Command-Unterstützung.

### Konfiguration

`settings.json` ist die zentrale Quelle fuer Konfigurationen jeder Art.

Der Einstiegspunkt lädt diese Datei beim Start, ergänzt fehlende Defaults und schreibt sie bei Bedarf zurück.

Aktuell sind dort insbesondere diese Bereiche hinterlegt:

- `commands.prefix` fuer das Command-Praefix
- `chat.*` fuer Prompt- und Begruessungstexte
- `editor.command` fuer einen optionalen expliziten Editor-Befehl
- `files.settingsPath` als Ziel fuer `/settings`
- `llm.*` fuer Provider-, Modell- und Prompt-Konfiguration
- `tools.*` fuer lokale Agent-Tools und deren Roundtrip-Limits
- `ui.title` fuer den TUI-Titel

### LLM-Konfiguration

Die Anwendung bringt eine Default-Konfiguration fuer zwei OpenAI-kompatible Provider mit:

- `openai` mit `OPENAI_API_KEY`
- `openrouter` mit `OPENROUTER_API_KEY`

Modelle werden ueber sprechende Aliase in `llm.models` definiert. Jedes Alias verweist auf:

- `provider`
- `model`
- `temperature`
- `maxTokens`

Die Low-Level-Inference liegt in [src/inference.ts](/Users/frankhildebrandt/Library/Application Support/Stackriot/Worktrees/my_agent/base/src/inference.ts). Der Wrapper sendet Requests bewusst direkt an `POST /chat/completions`, damit weitere OpenAI-kompatible Provider spaeter ohne neue Client-Bibliothek angebunden werden koennen.

Vor dem Start muessen die API-Keys als Umgebungsvariablen gesetzt sein:

```bash
export OPENAI_API_KEY="..."
export OPENROUTER_API_KEY="..."
```

Alternativ kann im Projektverzeichnis eine `.env` liegen. Sie wird beim Start automatisch eingelesen, ohne bereits gesetzte Prozessvariablen zu ueberschreiben.

### Commands

- `/settings` oeffnet `settings.json` im Default-Editor des Systems
- `/models` listet konfigurierte Modell-Aliase
- `/use <alias>` wechselt das aktive Modell fuer die laufende Session
- `/debug` schaltet einen session-lokalen Debug-Modus an oder aus; bei aktiver Option zeigt die TUI zusaetzlich Embedding-Aufrufe, genutzte Memory-Bloecke und den segmentierten effektiven Prompt
- `/reset` leert Session und `short_term_memory`, laesst `mid_term_memory` und `long_term_memory` aber unberuehrt
- `/sleep` verdichtet `short_term_memory` per LLM in dedupliziertes `mid_term_memory` und in strengere, bewaehrte `long_term_memory`-Fragmente; dabei sollen insbesondere erzeugte oder benutzte Tools und Hilfsskripte mit Namen, Zweck, Parametern und Funktionsweise kompakt festgehalten werden; danach wird die Session geleert
- `/sleepquiet` verhaelt sich wie `/sleep`, zeigt aber nur eine knappe Erfolgsmeldung
- `/memoryreset` leert `short_term_memory`, `mid_term_memory` und `long_term_memory` komplett

### Tool-Registry

Wenn `tools.enabled` aktiv ist, laeuft der Agent nicht mehr nur als einfache Chat-Completion, sondern in einer Tool-Loop.

Die Tool-Implementierungen liegen modular unter [src/tools](/Users/frankhildebrandt/Library/Application%20Support/Stackriot/Worktrees/my_agent/base/src/tools):

- `definitions/` enthaelt je Tool eine eigene Datei
- `registry.ts` registriert die verfuegbaren Tools
- `prompt.ts` baut den Tool-spezifischen Prompt aus den registrierten Metadaten
- `parse.ts` validiert Tool-Responses gegen die Registry

Aktuell sind drei Tools registriert:

- `query_script_registry` durchsucht bekannte Hilfsskripte ueber Registry-Metadaten und Embedding-Suche
- `create_typescript_file` erzeugt `.ts`-Dateien innerhalb von `tools.scriptsDir` und veroeffentlicht sie mit Hilfetext in der Registry
- `run_typescript_file` fuehrt diese Dateien mit `tsx` aus und gibt `stdout`, `stderr`, Exitcode und Timeout-Status an das Modell zurueck

Die Loop endet, sobald das Modell eine finale Antwort liefert oder `tools.maxRoundtrips` erreicht ist.

### Script Registry

Die Script-Registry liegt standardmaessig in `./agent_scripts/registry.json`.

Neue Skripte werden beim Tool `create_typescript_file` zusammen mit einem kurzen Hilfetext dort veroeffentlicht. `query_script_registry` kann diese Eintraege spaeter wiederfinden und nutzt dafuer bevorzugt Embeddings ueber Pfad plus Hilfetext; wenn kein Embedding verfuegbar ist, faellt die Suche auf einfache Textbewertung zurueck.

### Agent Memory

Der Agent nutzt jetzt ein fragmentiertes Drei-Stufen-Memory:

- `short_term_memory` fuer fluechtigen Session-Kontext aus Unterhaltung, Tool-Nutzung und lokalen Zwischenstaenden
- `mid_term_memory` fuer deduplizierte, aktuell relevante Arbeits-Erinnerungen mit begrenzter Haltbarkeit; dieser Tier darf weniger relevante Eintraege wieder vergessen
- `long_term_memory` fuer bewaehrte, sichere Wissensfragmente, die bereits schnell zu guten Ergebnissen gefuehrt haben; dieser Tier wird im normalen Betrieb nicht vergessen

Das zentrale Ziel ist kleine Prompts. Vor jeder Nutzeranfrage werden nur die relevantesten `long_term_memory`- und `mid_term_memory`-Fragmente sowie ein kompaktes `short_term_memory`-Snapshot in den Prompt geladen. Ganze Verlaeufe oder grosse Memory-Dateien werden nicht mehr implizit mitgeschleppt.

Mit `/debug` kann die TUI diese Auswahl sichtbar machen. Der Modus zeigt nur Beobachtungsdaten an: verwendete Embedding-Requests, Retrieval-Pfad fuer Mid-/Long-Term-Memory und den nach Segmenten getrennten Prompt. Die eigentliche Ranking-, Tool- und Prompt-Logik wird dadurch nicht veraendert.

Persistentes Wissen wird nicht mehr direkt per Tool geschrieben. Stattdessen landet neuer Kontext zuerst im `short_term_memory` und wird erst mit `/sleep` oder `/sleepquiet` in `mid_term_memory` und gegebenenfalls zusaetzlich in `long_term_memory` hochgestuft.

Wichtige Settings:

- `memory.shortTerm.mode` steuert, ob STM aus Buffer, Conversation oder hybrid aufgebaut wird
- `memory.shortTerm.maxTotalChars` begrenzt die gesamte STM-Menge im Prompt
- `memory.shortTerm.persistPath` definiert die persistente Session-Ablage fuer STM
- `memory.midTerm.dir` definiert das Zielverzeichnis fuer Mid-Term-Fragmente
- `memory.midTerm.indexPath` definiert den persistierten `vectra`-Indexordner fuer Mid-Term-Fragmente
- `memory.midTerm.topK` begrenzt die Anzahl relevanter Mid-Term-Fragmente pro Anfrage
- `memory.midTerm.maxFragmentChars` begrenzt die Groesse einzelner Mid-Term-Fragmente
- `memory.midTerm.maxTotalChars` begrenzt die gesamte Mid-Term-Menge im Prompt
- `memory.midTerm.maxFragmentsPerSleep` begrenzt die Anzahl neuer oder aktualisierter Mid-Term-Fragmente pro Sleep-Durchlauf
- `memory.midTerm.maxEntries` begrenzt, wie viele Mid-Term-Fragmente nach Relevanz behalten werden; weniger relevante Eintraege werden entfernt
- `memory.longTerm.dir` definiert das Zielverzeichnis fuer fragmentiertes persistentes Wissen
- `memory.longTerm.indexPath` definiert den persistierten `vectra`-Indexordner fuer LTM-Fragmente
- `memory.longTerm.topK` begrenzt die Anzahl relevanter Fragmente pro Anfrage
- `memory.longTerm.maxFragmentChars` begrenzt die Groesse einzelner Fragmente
- `memory.longTerm.maxTotalChars` begrenzt die gesamte LTM-Menge im Prompt
- `memory.longTerm.maxFragmentsPerSleep` begrenzt die Anzahl neuer Fragmente pro Sleep-Durchlauf
- `scriptRegistry.path` definiert die persistente Registry-Datei fuer Hilfsskripte
- `scriptRegistry.topK` begrenzt die Anzahl der Suchtreffer
- `scriptRegistry.embeddings.*` konfiguriert Provider, Modell und Timeout fuer die Vektorsuche
- `tools.enabled` schaltet die Tool-Loop an oder aus
- `tools.scriptsDir` definiert das Zielverzeichnis fuer erzeugte Scripts
- `tools.executionTimeoutMs` begrenzt die Laufzeit eines Script-Aufrufs
- `tools.maxRoundtrips` begrenzt die Anzahl aufeinanderfolgender Tool-Aufrufe pro Nutzeranfrage

### Entwicklung

`npm run dev`

Startet die TUI direkt mit `tsx` im Watch-Modus.

### Typprüfung

`npm test`

Führt derzeit eine strikte TypeScript-Prüfung ohne Emit aus.

### Build

`npm run build`

Kompiliert den Quellcode nach `dist/`.

### Produktion

`npm start`

Startet den kompilierten Build aus `dist/index.js`.

## Ziele

- Entwicklung eines selbstlernenden KI-Agenten
- Automatisierung von Aufgaben
- Erweiterbarkeit und Anpassungsfähigkeit

## Nächste Schritte

- [ ] Dokumentation der API
- [ ] Beispiele für die Verwendung
- [ ] Testabdeckung erhöhen
- [ ] Weitere Features implementieren

## Annahmen

- Der Agent ist in TypeScript geschrieben.
- Node.js und npm sind erforderlich, um den Agenten auszuführen.
- Das Projekt nutzt aktuell TypeScript `5.9.2`.
- Weitere Details zur Funktionalität und Verwendung sind noch ausständig und werden in Kürze hinzugefügt.
