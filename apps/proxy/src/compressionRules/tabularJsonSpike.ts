import { isRecord } from "../util.js";
import { compactJsonString } from "./jsonCompaction.js";

export type TabularJsonSpikeCandidate = {
  original: string;
  compactJson: string;
  encoded: string;
  columns: string[];
  rowCount: number;
};

const FORMAT = "prompt-proxy.tabular-json.v1";

export function tabularJsonSpikeCandidate(text: string): TabularJsonSpikeCandidate | undefined {
  const original = text.trim();
  const compactJson = compactJsonString(original);
  if (!compactJson || !original.startsWith("[")) return undefined;
  if (containsUnsafeNumberToken(original)) return undefined;
  const objectSpans = topLevelObjectSpans(original);
  if (objectSpans === undefined || objectSpans.some(hasDuplicateTopLevelKeys)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isRecord)) return undefined;

  const columns = Object.keys(parsed[0]);
  if (columns.length === 0 || columns.some(isIntegerLikeKey)) return undefined;
  const rows: unknown[][] = [];
  for (const row of parsed) {
    const keys = Object.keys(row);
    if (!sameKeys(columns, keys)) return undefined;
    const values = columns.map((column) => row[column]);
    if (!values.every(isPrimitiveJsonValue)) return undefined;
    rows.push(values);
  }

  const encoded = JSON.stringify({ format: FORMAT, columns, rows });
  if (encoded.length >= compactJson.length) return undefined;
  return { original, compactJson, encoded, columns, rowCount: rows.length };
}

export function expandTabularJsonSpike(encoded: string): unknown[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.format !== FORMAT || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) {
    return undefined;
  }
  const columns = parsed.columns.filter((column): column is string => typeof column === "string");
  if (columns.length !== parsed.columns.length) return undefined;
  const rows = parsed.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) return undefined;
    return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
  });
  return rows.some((row) => row === undefined) ? undefined : rows;
}

function containsUnsafeNumberToken(text: string) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== "-" && (char < "0" || char > "9")) continue;
    const start = index;
    index += 1;
    while (index < text.length && /[0-9.eE+-]/.test(text[index])) index += 1;
    const token = text.slice(start, index);
    index -= 1;
    const digits = token.replace(/[^0-9]/g, "");
    if (token.includes(".") || token.includes("e") || token.includes("E") || digits.length >= 16) return true;
  }
  return false;
}

function topLevelObjectSpans(text: string) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart: number | undefined;
  const spans: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[" || char === "{") {
      if (char === "{" && depth === 1) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === "]" || char === "}") {
      depth -= 1;
      if (char === "}" && depth === 1 && objectStart !== undefined) {
        spans.push(text.slice(objectStart, index + 1));
        objectStart = undefined;
      }
      if (depth < 0) return undefined;
    }
  }
  return depth === 0 ? spans : undefined;
}

function hasDuplicateTopLevelKeys(objectText: string) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  const keys = new Set<string>();
  for (let index = 0; index < objectText.length; index += 1) {
    const char = objectText[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        if (depth === 1 && isKeyString(objectText, index + 1)) {
          const key = JSON.parse(objectText.slice(stringStart, index + 1)) as string;
          if (keys.has(key)) return true;
          keys.add(key);
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stringStart = index;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;
  }
  return false;
}

function isKeyString(text: string, start: number) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return text[index] === ":";
}

function isPrimitiveJsonValue(value: unknown) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && left.every((key, index) => right[index] === key);
}

function isIntegerLikeKey(key: string) {
  return /^(0|[1-9]\d*)$/.test(key);
}
