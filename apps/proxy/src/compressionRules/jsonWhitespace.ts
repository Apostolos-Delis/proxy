import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";
import { compactJsonString } from "./jsonCompaction.js";

export const jsonWhitespaceRule: CompressionRule = {
  label: "json-whitespace",
  version: 1,
  matches: () => true,
  filter: ({ content }) => mapTextContent(content, compactJsonString),
  minChars: 512
};

export { compactJsonString };
