import blessed from "blessed";
import { loadDotEnv } from "../../env";
import { AgentControlSocketService } from "../../infrastructure/control/AgentControlSocketService";
import type { AgentExternalEvent, AgentExternalRequestState, AgentModulePanelState } from "../../domain/agentControlTypes";
import type { IAgentModuleService, IChatView, IClock, IEditorLauncher, IInferenceClient, IMemoryRepository, IScriptRegistryRepository, IToolExecutor } from "../../domain/ports";
import type { AppSettings } from "../../settings";
import { SessionContext } from "../../application/session/SessionContext";
import { ContextBuilder } from "../../application/chat/ContextBuilder";
import { ChatController } from "../../application/chat/ChatController";
import { TranscriptPresenter } from "./TranscriptPresenter";
import { StatusBarPresenter } from "./StatusBarPresenter";
import type { AgentModuleRuntimeInfo } from "../../modules";

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
  private readonly modulePanelsContainer: blessed.Widgets.BoxElement;
  private readonly transcriptPresenter: TranscriptPresenter;
  private readonly statusBarPresenter: StatusBarPresenter;
  private readonly chatController: ChatController;
  private readonly controlSocketService: AgentControlSocketService;
  private readonly moduleManager: blessed.Widgets.BoxElement;
  private readonly moduleList: blessed.Widgets.ListTableElement;
  private readonly moduleDetails: blessed.Widgets.BoxElement;
  private statusTicker: NodeJS.Timeout | null = null;
  private readonly pageScrollStep = 12;
  private readonly lineScrollStep = 3;
  private externalRequestState: AgentExternalRequestState = {
    active: null,
    queued: [],
  };
  private readonly modulePanels = new Map<string, AgentModulePanelState>();
  private readonly modulePanelBoxes = new Map<string, blessed.Widgets.BoxElement>();
  private moduleManagerVisible = false;

  constructor(
    private readonly settings: AppSettings,
    private readonly clock: IClock,
    private readonly editorLauncher: IEditorLauncher,
    private readonly inferenceClient: IInferenceClient,
    private readonly memoryRepository: IMemoryRepository,
    private readonly scriptRegistryRepository: IScriptRegistryRepository,
    private readonly toolExecutor: IToolExecutor,
    private readonly agentModuleService: IAgentModuleService,
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
    this.modulePanelsContainer = blessed.box({
      parent: this.screen,
      top: 0,
      right: 0,
      width: "32%",
      height: "100%-6",
      hidden: true,
      border: "line",
      label: " Modulfenster ",
      style: {
        fg: "white",
        bg: "black",
        border: {
          fg: "green",
        },
      },
    });

    this.transcriptPresenter = new TranscriptPresenter(this.messages, this.screen, this.clock);
    this.statusBarPresenter = new StatusBarPresenter(
      this.status,
      this.screen,
      () => this.transcriptPresenter.historyLength,
      () => this.messages.getScrollPerc(),
      () => this.externalRequestState,
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
      this.agentModuleService,
      () => this.exit(),
    );
    this.controlSocketService = new AgentControlSocketService(this.settings, this.chatController, this);
    this.moduleManager = blessed.box({
      parent: this.screen,
      top: "center",
      left: "center",
      width: "92%",
      height: "82%",
      hidden: true,
      tags: true,
      border: "line",
      label: " Modulmanager ",
      style: {
        fg: "white",
        bg: "black",
        border: {
          fg: "yellow",
        },
      },
    });
    this.moduleList = blessed.listtable({
      parent: this.moduleManager,
      top: 0,
      left: 0,
      width: "100%",
      height: "70%",
      keys: true,
      mouse: true,
      border: "line",
      align: "left",
      style: {
        header: {
          fg: "black",
          bg: "yellow",
        },
        cell: {
          selected: {
            fg: "black",
            bg: "cyan",
          },
        },
        border: {
          fg: "yellow",
        },
      },
    });
    this.moduleDetails = blessed.box({
      parent: this.moduleManager,
      bottom: 0,
      left: 0,
      width: "100%",
      height: "30%",
      tags: true,
      border: "line",
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        border: {
          fg: "yellow",
        },
      },
    });
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
    void this.controlSocketService
      .start()
      .then(() => {
        this.appendMessage("sys>", `Agent-Socket bereit: ${this.settings.controlSocket.path}`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.appendMessage("sys>", `Agent-Socket konnte nicht gestartet werden: ${message}`);
      });
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

  notifyExternalEvent(event: AgentExternalEvent): void {
    const suffix = event.message ?? event.chunk ?? "";
    const label = `[extern ${event.label} ${event.requestId.slice(0, 8)}]`;
    if (event.type === "stream") {
      return;
    }

    this.appendMessage("sys>", `${label} ${event.type}${suffix ? `: ${suffix}` : ""}`);
  }

  setExternalRequestState(state: AgentExternalRequestState): void {
    this.externalRequestState = state;
    this.statusBarPresenter.render();
  }

  upsertModulePanel(panel: AgentModulePanelState): void {
    this.modulePanels.set(panel.panelId, panel);
    this.renderModulePanels();
  }

  removeModulePanel(panelId: string): void {
    this.modulePanels.delete(panelId);
    const existing = this.modulePanelBoxes.get(panelId);
    if (existing) {
      existing.detach();
      this.modulePanelBoxes.delete(panelId);
    }
    this.renderModulePanels();
  }

  renderDebugReport(report: string): void {
    this.appendMessage("debug>", report);
  }

  private bindEvents(): void {
    this.screen.key(["C-c"], () => {
      this.exit();
    });

    this.screen.key(["escape"], () => {
      if (this.moduleManagerVisible) {
        this.toggleModuleManager(false);
        return;
      }
      this.chatController.abortActiveExecution();
    });

    this.screen.key(["f2"], () => {
      this.toggleModuleManager(!this.moduleManagerVisible);
    });

    this.screen.key(["f4"], () => {
      const active = this.externalRequestState.active;
      if (!active) {
        this.appendMessage("sys>", "Keine aktive externe Anfrage vorhanden.");
        return;
      }

      this.chatController.abortRequest(active.id);
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

    this.moduleList.on("select", () => {
      this.renderModuleDetails();
    });

    this.moduleManager.key(["escape", "f2"], () => {
      this.toggleModuleManager(false);
    });
    this.moduleManager.key(["r"], () => {
      this.refreshModuleManager();
    });
    this.moduleManager.key(["s"], () => {
      void this.handleSelectedModuleAction("start");
    });
    this.moduleManager.key(["x"], () => {
      void this.handleSelectedModuleAction("stop");
    });
    this.moduleManager.key(["d"], () => {
      void this.handleSelectedModuleAction("disable");
    });
    this.moduleManager.key(["e"], () => {
      void this.handleSelectedModuleAction("enable");
    });

    this.screen.append(this.messages);
    this.screen.append(this.modulePanelsContainer);
    this.screen.append(this.status);
    this.screen.append(this.input);
    this.screen.append(this.moduleManager);
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
    void this.controlSocketService.stop();
    this.screen.destroy();
    process.exit(0);
  }

  private toggleModuleManager(visible: boolean): void {
    this.moduleManagerVisible = visible;
    this.moduleManager.hidden = !visible;
    if (visible) {
      this.refreshModuleManager();
      this.moduleList.focus();
    } else {
      this.input.focus();
    }
    this.screen.render();
  }

  private refreshModuleManager(): void {
    const modules = this.agentModuleService.getRuntimeInfos(this.settings);
    const rows = [
      ["Modul", "Status", "Enabled", "PID"],
      ...modules.map((entry) => [
        entry.name,
        entry.status,
        entry.enabled ? "yes" : "no",
        entry.pid === null ? "-" : String(entry.pid),
      ]),
    ];
    this.moduleList.setData(rows);
    this.moduleList.select(Math.min(1, Math.max(rows.length - 1, 0)));
    this.renderModuleDetails();
    this.screen.render();
  }

  private renderModuleDetails(): void {
    const info = this.getSelectedModuleInfo();
    if (!info) {
      this.moduleDetails.setContent("Keine Module gefunden.");
      return;
    }

    this.moduleDetails.setContent(
      [
        `{bold}${info.name}{/bold} | ${info.status} | enabled=${info.enabled ? "yes" : "no"} | pid=${info.pid ?? "-"}`,
        `Socket: ${info.socketPath}`,
        `Pfad: ${info.moduleDir}`,
        `Fehler: ${info.lastError ?? "-"}`,
        `Logs: ${info.recentLogs.slice(-3).join(" | ") || "-"}`,
        "Aktionen: s=start, x=stop, d=disable, e=enable, r=refresh, Esc/F2=schliessen",
      ].join("\n"),
    );
  }

  private getSelectedModuleInfo(): AgentModuleRuntimeInfo | null {
    const runtimeInfos = this.agentModuleService.getRuntimeInfos(this.settings);
    const selectedIndex = Math.max(
      (((this.moduleList as unknown as { selected?: number }).selected ?? 1) - 1),
      0,
    );
    return runtimeInfos[selectedIndex] ?? null;
  }

  private async handleSelectedModuleAction(action: "start" | "stop" | "enable" | "disable"): Promise<void> {
    const info = this.getSelectedModuleInfo();
    if (!info) {
      return;
    }

    try {
      if (action === "start") {
        await this.agentModuleService.start(this.settings, info.name);
      } else if (action === "stop") {
        await this.agentModuleService.stop(this.settings, info.name);
      } else if (action === "enable") {
        await this.agentModuleService.setEnabled(this.settings, info.name, true);
      } else {
        await this.agentModuleService.setEnabled(this.settings, info.name, false);
      }
      this.appendMessage("sys>", `Modulmanager: ${info.name} -> ${action}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendMessage("sys>", `Modulmanager-Fehler fuer ${info.name}: ${message}`);
    }

    this.refreshModuleManager();
  }

  private renderModulePanels(): void {
    const panels = [...this.modulePanels.values()];
    this.modulePanelsContainer.hidden = panels.length === 0;
    this.messages.width = panels.length === 0 ? "100%" : "68%";

    const activeIds = new Set(panels.map((panel) => panel.panelId));
    for (const [panelId, element] of this.modulePanelBoxes.entries()) {
      if (!activeIds.has(panelId)) {
        element.detach();
        this.modulePanelBoxes.delete(panelId);
      }
    }

    const heightPercent = panels.length > 0 ? Math.max(Math.floor(100 / panels.length), 25) : 100;
    panels.forEach((panel, index) => {
      let element = this.modulePanelBoxes.get(panel.panelId);
      if (!element) {
        element = blessed.box({
          parent: this.modulePanelsContainer,
          left: 0,
          width: "100%",
          tags: true,
          scrollable: true,
          alwaysScroll: true,
          border: "line",
          padding: {
            left: 1,
            right: 1,
          },
          style: {
            fg: "white",
            bg: "black",
            border: {
              fg: "green",
            },
          },
        });
        this.modulePanelBoxes.set(panel.panelId, element);
      }

      element.top = `${index * heightPercent}%`;
      element.height = index === panels.length - 1 ? `${100 - index * heightPercent}%` : `${heightPercent}%`;
      element.setLabel(` ${panel.moduleName}: ${panel.title} `);
      element.setContent(panel.content);
    });

    this.screen.render();
  }
}
