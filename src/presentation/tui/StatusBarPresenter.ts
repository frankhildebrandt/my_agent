import blessed from "blessed";
import type { StatusVariant } from "../../domain/ports";

const STATUS_FRAMES = ["[   ]", "[=  ]", "[== ]", "[===]", "[ ==]", "[  =]"];
const STATUS_VARIANT_THEME: Record<
  StatusVariant,
  { label: string; accent: string; border: string; glow: string }
> = {
  idle: {
    label: " Bereit ",
    accent: "cyan",
    border: "blue",
    glow: "white",
  },
  request: {
    label: " Anfrage ",
    accent: "yellow",
    border: "yellow",
    glow: "white",
  },
  tool: {
    label: " Tools ",
    accent: "magenta",
    border: "magenta",
    glow: "white",
  },
  error: {
    label: " Fehler ",
    accent: "red",
    border: "red",
    glow: "white",
  },
};

function escapeTags(value: string): string {
  return blessed.escape(value);
}

export class StatusBarPresenter {
  private readonly transientStatus = {
    message: "",
    variant: "idle" as StatusVariant,
    frameIndex: 0,
  };

  constructor(
    private readonly status: blessed.Widgets.BoxElement,
    private readonly screen: blessed.Widgets.Screen,
    private readonly historyLengthProvider: () => number,
    private readonly scrollPercentProvider: () => number,
  ) {}

  setTransientStatus(message: string, variant: StatusVariant): void {
    const nextMessage = message.trim();
    const variantChanged = this.transientStatus.variant !== variant;
    const messageChanged = this.transientStatus.message !== nextMessage;

    this.transientStatus.message = nextMessage;
    this.transientStatus.variant = variant;
    if (variantChanged || messageChanged) {
      this.transientStatus.frameIndex = 0;
    }

    this.render();
  }

  clearTransientStatus(): void {
    this.transientStatus.message = "";
    this.transientStatus.variant = "idle";
    this.transientStatus.frameIndex = 0;
    this.render();
  }

  tick(): void {
    this.transientStatus.frameIndex = (this.transientStatus.frameIndex + 1) % STATUS_FRAMES.length;
    this.render();
  }

  render(): void {
    const theme = STATUS_VARIANT_THEME[this.transientStatus.variant];
    const frame = STATUS_FRAMES[this.transientStatus.frameIndex % STATUS_FRAMES.length];
    const message =
      this.transientStatus.message.length > 0 ? this.transientStatus.message : "Bereit fuer Eingabe";
    const historyInfo = `Verlauf ${this.historyLengthProvider()}/2000`;
    const scrollInfo = `Scroll ${Math.round(this.scrollPercentProvider())}%`;
    const hint = "PgUp/PgDn scrollt, Ende springt nach unten, Esc bricht ab";

    this.status.style.border.fg = theme.border;
    this.status.setLabel(theme.label);
    this.status.setContent(
      [
        `{${theme.accent}-fg}${frame}{/${theme.accent}-fg} {bold}{${theme.glow}-fg}${escapeTags(message)}{/${theme.glow}-fg}{/bold}`,
        `{gray-fg}${historyInfo} | ${scrollInfo} | ${hint}{/gray-fg}`,
      ].join("\n"),
    );

    this.screen.render();
  }
}

