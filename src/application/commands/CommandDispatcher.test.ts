import test from "node:test";
import assert from "node:assert/strict";
import { CommandDispatcher } from "./CommandDispatcher";

test("CommandDispatcher dispatches known commands and passes aliases", async () => {
  const calls: string[] = [];
  const dispatcher = new CommandDispatcher("/", {
    onHelp: () => {
      calls.push("help");
    },
    onNew: () => {
      calls.push("new");
    },
    onUsage: () => {
      calls.push("usage");
    },
    onCredits: () => {
      calls.push("credits");
    },
    onSettings: () => {
      calls.push("settings");
    },
    onModels: () => {
      calls.push("models");
    },
    onUse: (alias) => {
      calls.push(`use:${alias}`);
    },
    onDebug: () => {
      calls.push("debug");
    },
    onReset: () => {
      calls.push("reset");
    },
    onSleep: (quiet) => {
      calls.push(quiet ? "sleepquiet" : "sleep");
    },
    onMemoryReset: () => {
      calls.push("memoryreset");
    },
    onQuit: () => {
      calls.push("quit");
    },
    onUnknown: (raw) => {
      calls.push(`unknown:${raw}`);
    },
  });

  assert.equal(await dispatcher.dispatch("/use openai-default"), true);
  assert.equal(await dispatcher.dispatch("/sleepquiet"), true);
  assert.equal(await dispatcher.dispatch("plain text"), false);
  assert.deepEqual(calls, ["use:openai-default", "sleepquiet"]);
});

test("CommandDispatcher routes unknown commands", async () => {
  let unknown = "";
  const dispatcher = new CommandDispatcher("/", {
    onHelp: () => undefined,
    onNew: () => undefined,
    onUsage: () => undefined,
    onCredits: () => undefined,
    onSettings: () => undefined,
    onModels: () => undefined,
    onUse: () => undefined,
    onDebug: () => undefined,
    onReset: () => undefined,
    onSleep: () => undefined,
    onMemoryReset: () => undefined,
    onQuit: () => undefined,
    onUnknown: (raw) => {
      unknown = raw;
    },
  });

  await dispatcher.dispatch("/does-not-exist");
  assert.equal(unknown, "/does-not-exist");
});
