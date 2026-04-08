import test from "node:test";
import assert from "node:assert/strict";
import { ProviderCatalog } from "./ProviderCatalog";
import { defaultSettings } from "../../settings";
import { InferenceError } from "./InferenceError";

test("ProviderCatalog resolves configured model aliases", () => {
  const catalog = new ProviderCatalog();
  const resolved = catalog.resolveModel(defaultSettings, "openai-default");

  assert.equal(resolved.providerName, "openai");
  assert.equal(resolved.modelConfig.model, "gpt-5-mini");
  assert.equal(resolved.providerConfig.apiKeyEnv, "OPENAI_API_KEY");
});

test("ProviderCatalog throws for unknown aliases", () => {
  const catalog = new ProviderCatalog();

  assert.throws(() => catalog.resolveModel(defaultSettings, "missing"), InferenceError);
});

