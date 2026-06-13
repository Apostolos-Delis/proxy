import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";

export const jsonWhitespaceRule: CompressionRule = {
  label: "json-whitespace",
  version: 1,
  matches: () => true,
  filter: ({ content }) => mapTextContent(content, compactJsonString),
  minChars: 512
};

export function compactJsonString(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const stripped = stripJsonWhitespace(trimmed);
  return stripped.length < text.length ? stripped : undefined;
}

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
