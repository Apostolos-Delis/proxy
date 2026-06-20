import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";
import { compactJsonString } from "./jsonCompaction.js";

// Deterministic, lossless whitespace compaction for MCP tool results. MCP
// servers commonly return pretty-printed JSON; removing the insignificant
// whitespace reclaims tokens without changing a single value the model sees.
//
// We deliberately do NOT round-trip through JSON.parse/JSON.stringify: that
// silently corrupts integers beyond 2^53 (snowflake IDs from GitHub, Linear,
// Slack, etc.), normalizes number representation (1.0 → 1), and would let us
// drop null keys — all of which change what the model reasons over. Instead we
// validate the payload is well-formed JSON, then strip whitespace at the string
// level while copying string literals verbatim. The output is a pure function
// of the input, so the prompt-cache prefix stays stable.
//
// Claude Code wraps MCP results as [{type:"text", text:"<json>"}]; Codex sends
// the JSON as a bare string. Both shapes are handled; non-JSON is left
// untouched (filter returns undefined).

export const mcpJsonRule: CompressionRule = {
  label: "mcp-json-whitespace",
  version: 1,
  matches: (toolName) => toolName.startsWith("mcp__"),
  filter: ({ content }) => mapTextContent(content, compactJsonString),
  // Cheap O(n) scan — worth running on mid-size results too.
  minChars: 512
};
