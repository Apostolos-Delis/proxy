import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";
import { compactJsonArrayTables } from "./jsonCompaction.js";

export const jsonArrayCompactionRule: CompressionRule = {
  label: "json-array-compaction",
  version: 1,
  matches: () => true,
  filter: ({ content }) => mapTextContent(content, compactJsonArrayTables),
  minChars: 512,
  lossy: true
};
