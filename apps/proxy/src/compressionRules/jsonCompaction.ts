import { isRecord } from "../util.js";

export type JsonArrayCompactionCandidate = {
  compactJson: string;
  encoded: string;
  tableCount: number;
  rowCount: number;
};

type JsonArrayTable = {
  columns: string[];
  rows: unknown[][];
};

const ARRAY_COMPACTION_FORMAT = "prompt-proxy.json-array-compaction.v1";
const MAX_CELL_JSON_CHARS = 2048;

export function compactJsonString(text: string): string | undefined {
  const stripped = compactJsonForComparison(text);
  return stripped !== undefined && stripped.length < text.length ? stripped : undefined;
}

export function compactJsonArrayTables(text: string): string | undefined {
  return jsonArrayCompactionCandidate(text)?.encoded;
}

export function jsonArrayCompactionCandidate(text: string): JsonArrayCompactionCandidate | undefined {
  const original = text.trim();
  const compactJson = compactJsonForComparison(original);
  if (!compactJson || containsUnsafeNumberToken(original) || hasDuplicateObjectKeys(original)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(original);
  } catch {
    return undefined;
  }

  const encoded = Array.isArray(parsed)
    ? encodedArrayCandidate(parsed)
    : encodedObjectCandidate(parsed);
  if (!encoded || encoded.length >= compactJson.length) return undefined;
  return { compactJson, encoded, tableCount: tableCount(encoded), rowCount: rowCount(encoded) };
}

export function expandJsonArrayCompaction(encoded: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.format !== ARRAY_COMPACTION_FORMAT || typeof parsed.kind !== "string") return undefined;
  if (parsed.kind === "array") {
    const table = tableFromUnknown(parsed);
    return table ? expandTable(table) : undefined;
  }
  if (parsed.kind !== "object" || !isRecord(parsed.fields)) return undefined;
  const output: Record<string, unknown> = isRecord(parsed.rest) ? { ...parsed.rest } : {};
  for (const key of Object.keys(parsed.fields)) {
    const table = tableFromUnknown(parsed.fields[key]);
    if (!table) return undefined;
    output[key] = expandTable(table);
  }
  return output;
}

function compactJsonForComparison(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return stripJsonWhitespace(trimmed);
}

function encodedArrayCandidate(value: unknown[]) {
  const table = tableForArray(value);
  return table ? JSON.stringify({ format: ARRAY_COMPACTION_FORMAT, kind: "array", ...table }) : undefined;
}

function encodedObjectCandidate(value: unknown) {
  if (!isRecord(value)) return undefined;
  const fields: Record<string, JsonArrayTable> = {};
  const rest: Record<string, unknown> = {};
  let rowCount = 0;
  for (const key of Object.keys(value)) {
    if (isIntegerLikeKey(key)) return undefined;
    const fieldValue = value[key];
    if (Array.isArray(fieldValue)) {
      const table = tableForArray(fieldValue);
      if (!table) return undefined;
      fields[key] = table;
      rowCount += table.rows.length;
    } else {
      if (!isPrimitiveJsonValue(fieldValue) || cellJsonTooLarge(fieldValue)) return undefined;
      rest[key] = fieldValue;
    }
  }
  if (rowCount === 0) return undefined;
  const payload = Object.keys(rest).length === 0
    ? { format: ARRAY_COMPACTION_FORMAT, kind: "object", fields }
    : { format: ARRAY_COMPACTION_FORMAT, kind: "object", rest, fields };
  return JSON.stringify(payload);
}

function tableForArray(value: unknown[]): JsonArrayTable | undefined {
  if (value.length === 0 || !value.every(isRecord)) return undefined;
  const first = value[0];
  const columns = Object.keys(first);
  if (columns.length === 0 || columns.some(isIntegerLikeKey)) return undefined;
  const rows: unknown[][] = [];
  for (const row of value) {
    if (!isRecord(row)) return undefined;
    const keys = Object.keys(row);
    if (!sameKeys(columns, keys)) return undefined;
    const cells = columns.map((column) => row[column]);
    if (!cells.every(isPrimitiveJsonValue) || cells.some(cellJsonTooLarge)) return undefined;
    rows.push(cells);
  }
  return { columns, rows };
}

function tableFromUnknown(value: unknown): JsonArrayTable | undefined {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) return undefined;
  const columns = value.columns;
  if (!columns.every((column): column is string => typeof column === "string")) return undefined;
  const rows: unknown[][] = [];
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.length !== columns.length) return undefined;
    rows.push(row);
  }
  return { columns, rows };
}

function expandTable(table: JsonArrayTable) {
  return table.rows.map((row) => Object.fromEntries(table.columns.map((column, index) => [column, row[index]])));
}

function tableCount(encoded: string) {
  const expanded = expandJsonArrayCompaction(encoded);
  if (Array.isArray(expanded)) return 1;
  if (!isRecord(expanded)) return 0;
  return Object.values(expanded).filter(Array.isArray).length;
}

function rowCount(encoded: string) {
  const expanded = expandJsonArrayCompaction(encoded);
  if (Array.isArray(expanded)) return expanded.length;
  if (!isRecord(expanded)) return 0;
  let count = 0;
  for (const value of Object.values(expanded)) {
    if (Array.isArray(value)) count += value.length;
  }
  return count;
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
    if (token === "-0" || token.includes(".") || token.includes("e") || token.includes("E") || digits.length >= 16) {
      return true;
    }
  }
  return false;
}

function hasDuplicateObjectKeys(text: string) {
  const spans = objectSpans(text);
  return spans === undefined || spans.some(hasDuplicateTopLevelKeys);
}

function objectSpans(text: string) {
  const stack: number[] = [];
  const spans: string[] = [];
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
    if (char === "{") {
      stack.push(index);
      continue;
    }
    if (char !== "}") continue;
    const start = stack.pop();
    if (start === undefined) return undefined;
    spans.push(text.slice(start, index + 1));
  }
  return stack.length === 0 ? spans : undefined;
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

function cellJsonTooLarge(value: unknown) {
  return JSON.stringify(value).length > MAX_CELL_JSON_CHARS;
}

function sameKeys(left: string[], right: string[]) {
  return left.length === right.length && left.every((key, index) => right[index] === key);
}

function isIntegerLikeKey(key: string) {
  return /^(0|[1-9]\d*)$/.test(key);
}
