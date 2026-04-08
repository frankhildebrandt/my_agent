import blessed from "blessed";
import { loadDotEnv } from "../../env";
import type { IChatView, IClock, IEditorLauncher, IInferenceClient, IMemoryRepository, IScriptRegistryRepository, IToolExecutor } from "../../domain/ports";
import type { AppSettings } from "../../settings";
import { SessionContext } from "../../application/session/SessionContext";
import { ContextBuilder } from "../../application/chat/ContextBuilder";
import { ChatController } from "../../application/chat/ChatController";
import { TranscriptPresenter } from "./TranscriptPresenter";
import { StatusBarPresenter } from "./StatusBarPresenter";

interface KeyBindable {
  key(keys: string | string[], listener: () => void): unknown;
}

export class TuiChatApplication implements IChatView {
  private readonly envPath = loadDotEnv();
  private readonly sessionContext: SessionContext;
  private readonly screen: blessed.Widgets.Screen;
  private readonly messages: blessed.Widgets.BoxElement;
  private readonly status: blessed.Widgets.BoxElement;
  private readonly input: blessed.Widgets.TextboxElement;
  private readonly transcriptPresenter: TranscriptPresenter;
  private readonly statusBarPresenter: StatusBarPresenter;
  private readonly chatController: ChatController;
  private statusTicker: NodeJS.Timeout | null = null;
  private readonly pageScrollStep = 12;
  private readonly lineScrollStep = 3;

  constructor(
    private readonly settings: AppSettings,
    private readonly clock: IClock,
    private readonly editorLauncher: IEditorLauncher,
    private readonly inferenceClient: IInferenceClient,
    private readonly memoryRepository: IMemoryRepository,
    private readonly scriptRegistryRepository: IScriptRegistryRepository,
    private readonly toolExecutor: IToolExecutor,
  ) {
    this.sessionContext = new SessionContext(this.settings, this.memoryRepository, this.clock);
    this.screen = blessed.screen({
      smartCSR: true,
      title: settings.ui.title,
      fullUnicode: true,
      dockBorders: true,
    });
    this.messages = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-6",
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: " ",
        style: {
          bg: "blue",
        },
      },
      label: ` ${settings.ui.title} `,
      border: "line",
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        fg: "white",
        bg: "black",
        border: {
          fg: "blue",
        },
        scrollbar: {
          bg: "blue",
        },
        focus: {
          border: {
            fg: "cyan",
          },
        },
      },
    });
    this.status = blessed.box({
      parent: this.screen,
      bottom: 3,
      left: 0,
      width: "100%",
      height: 3,
      border: "line",
      tags: true,
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        fg: "white",
        bg: "black",
        border: {
          fg: "blue",
        },
      },
    });
    this.input = blessed.textbox({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: "line",
      inputOnFocus: true,
      label: ` ${settings.chat.inputLabel} `,
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        fg: "white",
        bg: "black",
        border: {
          fg: "cyan",
        },
        focus: {
          border: {
            fg: "green",
          },
        },
      },
    });

    this.transcriptPresenter = new TranscriptPresenter(this.messages, this.screen, this.clock);
    this.statusBarPresenter = new StatusBarPresenter(
      this.status,
      this.screen,
      () => this.transcriptPresenter.historyLength,
      () => this.messages.getScrollPerc(),
    );
    this.chatController = new ChatController(
      this.settings,
      this,
      this.sessionContext,
      new ContextBuilder(this.settings, this.memoryRepository),
      this.inferenceClient,
      this.toolExecutor,
      this.editorLauncher,
      this.memoryRepository,
      this.scriptRegistryRepository,
      () => this.exit(),
    );
  }

  start(): void {
    this.bindEvents();
    this.statusTicker = setInterval(() => {
      this.statusBarPresenter.tick();
    }, 140);

    this.appendMessage(
      "sys>",
      [
        this.settings.chat.welcomeMessage,
        `Konfigurationsquelle: ${this.settings.files.settingsPath}`,
        this.envPath ? `.env geladen: ${this.envPath}` : ".env nicht gefunden, nutze Prozess-Environment.",
        `Aktives Modell: ${this.sessionContext.activeModelAlias}`,
        `Debug: ${this.sessionContext.debugEnabled ? "an" : "aus"}`,
      ].join(" | "),
    );

    this.input.focus();
    this.clearTransientStatus();
    this.transcriptPresenter.render();
    this.screen.render();
  }

  appendMessage(prefix: string, message: string, tone: "default" | "reasoning" = "default"): number {
    const index = this.transcriptPresenter.appendMessage(prefix, message, tone);
    this.statusBarPresenter.render();
    return index;
  }

  updateMessage(index: number, patch: Partial<{ prefix: string; message: string; tone: "default" | "reasoning" }>): void {
    this.transcriptPresenter.updateMessage(index, patch);
    this.statusBarPresenter.render();
  }

  appendToMessage(index: number, chunk: string): void {
    this.transcriptPresenter.appendToMessage(index, chunk);
    this.statusBarPresenter.render();
  }

  setTransientStatus(message: string, variant: "idle" | "request" | "tool" | "error"): void {
    this.statusBarPresenter.setTransientStatus(message, variant);
  }

  clearTransientStatus(): void {
    this.statusBarPresenter.clearTransientStatus();
  }

  renderDebugReport(report: string): void {
    this.appendMessage("debug>", report);
  }

  private bindEvents(): void {
    this.screen.key(["C-c"], () => {
      this.exit();
    });

    this.screen.key(["escape"], () => {
      this.chatController.abortActiveExecution();
    });

    this.bindScrollableKeys(this.screen);
    this.bindScrollableKeys(this.messages);
    this.bindScrollableKeys(this.input);

    this.messages.on("wheelup", () => {
      this.scrollMessagesBy(-this.lineScrollStep);
    });

    this.messages.on("wheeldown", () => {
      this.scrollMessagesBy(this.lineScrollStep);
    });

    this.input.on("submit", (value) => {
      void this.handleSubmit(value);
    });

    this.screen.append(this.messages);
    this.screen.append(this.status);
    this.screen.append(this.input);
  }

  private async handleSubmit(value: string): Promise<void> {
    await this.chatController.handlePrompt(value);
    this.input.clearValue();
    this.input.focus();
    this.screen.render();
  }

  private bindScrollableKeys(element: KeyBindable): void {
    element.key(["pageup"], () => {
      this.scrollMessagesBy(-this.pageScrollStep);
    });

    element.key(["pagedown"], () => {
      this.scrollMessagesBy(this.pageScrollStep);
    });

    element.key(["S-pageup"], () => {
      this.scrollMessagesBy(-this.pageScrollStep);
    });

    element.key(["S-pagedown"], () => {
      this.scrollMessagesBy(this.pageScrollStep);
    });

    element.key(["C-up"], () => {
      this.scrollMessagesBy(-this.lineScrollStep);
    });

    element.key(["C-down"], () => {
      this.scrollMessagesBy(this.lineScrollStep);
    });

    element.key(["home"], () => {
      this.messages.setScroll(0);
      this.screen.render();
    });

    element.key(["end"], () => {
      this.messages.setScrollPerc(100);
      this.screen.render();
    });
  }

  private scrollMessagesBy(delta: number): void {
    this.messages.scroll(delta);
    this.screen.render();
  }

  private exit(): never {
    if (this.statusTicker) {
      clearInterval(this.statusTicker);
    }
    this.screen.destroy();
    process.exit(0);
  }
}

