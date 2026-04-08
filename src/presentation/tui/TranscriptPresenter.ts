import blessed from "blessed";
import type { HistoryTone } from "../../domain/ports";
import type { IClock } from "../../domain/ports";

interface HistoryEntry {
  prefix: string;
  message: string;
  timestamp: string;
  tone: HistoryTone;
}

function escapeTags(value: string): string {
  return blessed.escape(value);
}

function colorizePrefix(prefix: string): string {
  if (prefix === "du>") {
    return "{cyan-fg}du>{/cyan-fg}";
  }

  if (prefix === "think>") {
    return "{gray-fg}think>{/gray-fg}";
  }

  if (prefix === "agent>") {
    return "{green-fg}agent>{/green-fg}";
  }

  if (prefix === "tool>") {
    return "{magenta-fg}tool>{/magenta-fg}";
  }

  if (prefix === "debug>") {
    return "{yellow-fg}debug>{/yellow-fg}";
  }

  return "{blue-fg}sys>{/blue-fg}";
}

export class TranscriptPresenter {
  private readonly history: HistoryEntry[] = [];
  private readonly maxHistoryEntries = 2000;

  constructor(
    private readonly messages: blessed.Widgets.BoxElement,
    private readonly screen: blessed.Widgets.Screen,
    private readonly clock: IClock,
  ) {}

  appendMessage(prefix: string, message: string, tone: HistoryTone = "default"): number {
    this.history.push({
      prefix,
      message,
      timestamp: this.clock.localeTime(),
      tone,
    });
    if (this.history.length > this.maxHistoryEntries) {
      this.history.splice(0, this.history.length - this.maxHistoryEntries);
    }
    this.render();
    return this.history.length - 1;
  }

  updateMessage(
    index: number,
    patch: Partial<{
      prefix: string;
      message: string;
      tone: HistoryTone;
    }>,
  ): void {
    const entry = this.history[index];
    if (!entry) {
      return;
    }

    this.history[index] = {
      ...entry,
      ...patch,
    };
    this.render();
  }

  appendToMessage(index: number, chunk: string): void {
    const entry = this.history[index];
    if (!entry || chunk.length === 0) {
      return;
    }

    this.history[index] = {
      ...entry,
      message: entry.message + chunk,
    };
    this.render();
  }

  render(): void {
    const lines = this.history.map((entry) => {
      const timestamp = `{gray-fg}[${entry.timestamp}]{/gray-fg}`;
      const body = escapeTags(entry.message);
      const styledBody = entry.tone === "reasoning" ? `{gray-fg}${body}{/gray-fg}` : body;
      return `${timestamp} ${colorizePrefix(entry.prefix)} ${styledBody}`;
    });
    this.messages.setContent(lines.join("\n"));
    this.messages.setScrollPerc(100);
    this.screen.render();
  }

  get historyLength(): number {
    return this.history.length;
  }
}

