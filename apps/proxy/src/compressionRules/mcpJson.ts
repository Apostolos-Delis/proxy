import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";

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
  matches: (toolName) => toolName.startsWith("mcp__"),
  filter: ({ content }) => mapTextContent(content, compactJsonString),
  // Cheap O(n) scan — worth running on mid-size results too.
  minChars: 512
};

// Returns the whitespace-stripped JSON string, or undefined if the input is not
// well-formed JSON or stripping did not shrink it.
function compactJsonString(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    JSON.parse(trimmed); // validate only — never reserialize through this
  } catch {
    return undefined;
  }
  const stripped = stripJsonWhitespace(trimmed);
  // Compared against the untrimmed input deliberately: outer padding is
  // formatting too, so already-compact JSON wrapped in whitespace still shrinks.
  return stripped.length < text.length ? stripped : undefined;
}

// Remove whitespace that sits outside string literals. Characters inside a JSON
// string (including escaped quotes) are copied verbatim, so values — numbers,
// nulls, keys, ordering, duplicate keys — are preserved exactly.
function stripJsonWhitespace(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === " " || char === "\n" || char === "\r" || char === "\t") continue;
    out += char;
  }
  return out;
}
