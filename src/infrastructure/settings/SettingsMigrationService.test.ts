import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defaultSettings } from "../../settings";
import { FileSettingsRepository } from "./FileSettingsRepository";
import { SettingsMigrationService } from "./SettingsMigrationService";

test("SettingsMigrationService migrates legacy flat memory settings", () => {
  const service = new SettingsMigrationService();
  const migrated = service.migrateLegacySettings({
    memory: {
      dir: "./legacy_memory",
      indexPath: "./legacy_memory/index.json",
      topK: 7,
      maxTotalChars: 9000,
      maxCharsPerFile: 3000,
    },
  }) as {
    memory: {
      shortTerm: { persistPath: string; maxTotalChars: number };
      midTerm: { dir: string; indexPath: string; topK: number; maxFragmentChars: number };
      longTerm: { dir: string; indexPath: string; topK: number; maxFragmentChars: number };
    };
  };

  assert.equal(migrated.memory.shortTerm.persistPath, "./legacy_memory/short_term_memory.json");
  assert.equal(migrated.memory.midTerm.dir, "./legacy_memory/mid_term_memory");
  assert.equal(migrated.memory.longTerm.dir, "./legacy_memory/long_term_memory");
  assert.equal(migrated.memory.midTerm.topK, 7);
  assert.equal(migrated.memory.midTerm.maxFragmentChars, 3000);
  assert.equal(migrated.memory.longTerm.indexPath, "./legacy_memory/long_term_index");
});

test("FileSettingsRepository shortens overly long unix socket paths", () => {
  const rootDir = mkdtempSync(resolve(tmpdir(), "agent-settings-"));
  const deepDir = resolve(rootDir, "this", "path", "is", "intentionally", "very", "long", "for", "unix", "socket", "tests");
  const settingsPath = resolve(deepDir, "settings.json");
  const longSocketPath = resolve(deepDir, "agent_socket", "control.sock");

  try {
    mkdirSync(deepDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        controlSocket: {
          path: longSocketPath,
        },
      }),
      "utf8",
    );

    const repository = new FileSettingsRepository(defaultSettings, new SettingsMigrationService(), settingsPath);
    const settings = repository.load();
    const persisted = JSON.parse(readFileSync(settingsPath, "utf8")) as { controlSocket: { path: string } };

    assert.ok(Buffer.byteLength(settings.controlSocket.path, "utf8") <= 103);
    assert.ok(settings.controlSocket.path.startsWith(`${tmpdir()}/`));
    assert.equal(persisted.controlSocket.path, settings.controlSocket.path);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
