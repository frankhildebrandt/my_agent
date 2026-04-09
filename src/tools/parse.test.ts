import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAssistantToolResponse, parseAssistantToolResponse } from "./parse";

test("parseAssistantToolResponse parses valid tool calls", () => {
  const parsed = parseAssistantToolResponse(
    '{"type":"tool_call","tool":"query_script_registry","arguments":{"query":"search"}}',
  );

  assert.deepEqual(parsed, {
    type: "tool_call",
    call: {
      tool: "query_script_registry",
      arguments: {
        query: "search",
      },
    },
  });
});

test("parseAssistantToolResponse rejects unknown tool names", () => {
  const parsed = parseAssistantToolResponse('{"type":"tool_call","tool":"unknown","arguments":{}}');
  assert.equal(parsed, null);
});

test("parseAssistantToolResponse accepts the first valid JSON object in mixed output", () => {
  const parsed = parseAssistantToolResponse(
    [
      '{"type":"tool_call","tool":"query_script_registry","arguments":{"query":"search"}}',
      '{"type":"final","message":"ignored"}',
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    type: "tool_call",
    call: {
      tool: "query_script_registry",
      arguments: {
        query: "search",
      },
    },
  });
});

test("parseAssistantToolResponse accepts JSON objects inside extra text", () => {
  const parsed = parseAssistantToolResponse(
    'Vorwort\n{"type":"final","message":"ok"}\nNachwort',
  );

  assert.deepEqual(parsed, {
    type: "final",
    message: "ok",
  });
});

test("analyzeAssistantToolResponse reports unknown tool names", () => {
  const parsed = analyzeAssistantToolResponse(
    '{"type":"tool_call","tool":"unknown","arguments":{}}',
  );

  assert.deepEqual(parsed, {
    ok: false,
    reason: "unknown_tool",
    details: "Ein tool_call wurde gefunden, aber das Tool ist nicht registriert: unknown.",
    snippet: '{"type":"tool_call","tool":"unknown","arguments":{}}',
  });
});

test("analyzeAssistantToolResponse reports missing JSON object", () => {
  const parsed = analyzeAssistantToolResponse("ich bin freitext");

  assert.deepEqual(parsed, {
    ok: false,
    reason: "no_json_object",
    details: "Es wurde kein vollstaendiges JSON-Objekt gefunden.",
    snippet: "ich bin freitext",
  });
});
