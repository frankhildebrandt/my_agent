import { IClock } from "../../domain/ports";

export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  localeTime(): string {
    return this.now().toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
}

