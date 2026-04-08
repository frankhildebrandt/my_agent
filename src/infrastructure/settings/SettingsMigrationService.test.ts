import test from "node:test";
import assert from "node:assert/strict";
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

