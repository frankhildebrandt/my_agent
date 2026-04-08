import test from "node:test";
import assert from "node:assert/strict";
import { parseAssistantToolResponse } from "./parse";

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

