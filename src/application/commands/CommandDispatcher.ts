import { formatHelpMessage } from "../chat/ChatHelpers";

export interface CommandHandlers {
  onHelp(): Promise<void> | void;
  onNew(): Promise<void> | void;
  onUsage(): Promise<void> | void;
  onCredits(): Promise<void> | void;
  onSettings(): Promise<void> | void;
  onModels(): Promise<void> | void;
  onUse(alias: string): Promise<void> | void;
  onDebug(): Promise<void> | void;
  onReset(): Promise<void> | void;
  onSleep(quiet: boolean): Promise<void> | void;
  onMemoryRoundup(): Promise<void> | void;
  onMemoryReset(): Promise<void> | void;
  onQuit(): Promise<void> | void;
  onUnknown(rawCommand: string): Promise<void> | void;
}

export class CommandDispatcher {
  constructor(
    private readonly prefix: string,
    private readonly handlers: CommandHandlers,
  ) {}

  isCommand(value: string): boolean {
    return value.startsWith(this.prefix);
  }

  async dispatch(value: string): Promise<boolean> {
    if (!this.isCommand(value)) {
      return false;
    }

    const command = value.slice(this.prefix.length).trim();

    if (command === "help") {
      await this.handlers.onHelp();
    } else if (command === "new") {
      await this.handlers.onNew();
    } else if (command === "usage") {
      await this.handlers.onUsage();
    } else if (command === "credits") {
      await this.handlers.onCredits();
    } else if (command === "settings") {
      await this.handlers.onSettings();
    } else if (command === "models") {
      await this.handlers.onModels();
    } else if (command.startsWith("use ")) {
      await this.handlers.onUse(command.slice(4).trim());
    } else if (command === "debug") {
      await this.handlers.onDebug();
    } else if (command === "reset") {
      await this.handlers.onReset();
    } else if (command === "sleep") {
      await this.handlers.onSleep(false);
    } else if (command === "sleepquiet") {
      await this.handlers.onSleep(true);
    } else if (command === "memoryroundup") {
      await this.handlers.onMemoryRoundup();
    } else if (command === "memoryreset") {
      await this.handlers.onMemoryReset();
    } else if (command === "quit") {
      await this.handlers.onQuit();
    } else {
      await this.handlers.onUnknown(value);
    }

    return true;
  }

  getHelpMessage(): string {
    return formatHelpMessage(this.prefix);
  }
}
