import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";

export type DiffCompactionCandidate = {
  encoded: string;
  hunkCount: number;
  omittedLines: number;
};

const DEFAULT_SHELL_TOOL_NAMES = ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"];
const FORMAT = "prompt-proxy.diff-compaction.v1";
const MIN_REPEATED_RUN = 6;
const MIN_CONTEXT_RUN = 12;

export const diffCompactionRule = diffCompactionRuleForNames(DEFAULT_SHELL_TOOL_NAMES);

export function diffCompactionRuleForNames(shellToolNames: readonly string[]): CompressionRule {
  const toolNames = new Set(shellToolNames);
  return {
    label: "diff-compaction",
    version: 1,
    matches: (toolName) => toolNames.has(toolName),
    filter: ({ content }) => mapTextContent(content, compactDiffOutput),
    minBytes: 4096,
    lossy: true
  };
}

export function compactDiffOutput(text: string): string | undefined {
  return diffCompactionCandidate(text)?.encoded;
}

export function diffCompactionCandidate(text: string): DiffCompactionCandidate | undefined {
  const lines = text.split("\n");
  if (!looksLikeUnifiedDiff(lines) || hasUnsafeDiffMarkers(lines)) return undefined;

  const output = [`[${FORMAT}; originalLines=${lines.length}; originalChars=${text.length}]`];
  let hunkCount = 0;
  let omittedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isHunkHeader(line)) {
      output.push(line);
      continue;
    }

    const bodyStart = index + 1;
    let bodyEnd = bodyStart;
    while (bodyEnd < lines.length && !isHunkHeader(lines[bodyEnd]) && !lines[bodyEnd].startsWith("diff --git ")) {
      bodyEnd += 1;
    }
    const body = lines.slice(bodyStart, bodyEnd);
    const counts = hunkCounts(body);
    output.push(line);
    output.push(`[hunk stats: added=${counts.added}; deleted=${counts.deleted}]`);
    const compacted = compactHunkBody(body);
    output.push(...compacted.lines);
    omittedLines += compacted.omittedLines;
    hunkCount += 1;
    index = bodyEnd - 1;
  }

  if (hunkCount === 0 || omittedLines === 0) return undefined;
  const encoded = output.join("\n");
  if (encoded.length >= text.length) return undefined;
  return { encoded, hunkCount, omittedLines };
}

function compactHunkBody(lines: string[]) {
  const output: string[] = [];
  let omittedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const contextRun = contextRunLength(lines, index);
    if (contextRun >= MIN_CONTEXT_RUN) {
      output.push(...lines.slice(index, index + 2));
      output.push(`[... ${contextRun - 4} unchanged diff context lines omitted ...]`);
      output.push(...lines.slice(index + contextRun - 2, index + contextRun));
      omittedLines += contextRun - 4;
      index += contextRun - 1;
      continue;
    }

    const repeatedRun = repeatedDiffRunLength(lines, index);
    if (repeatedRun >= MIN_REPEATED_RUN) {
      output.push(lines[index]);
      output.push(`[... ${repeatedRun - 2} repeated ${diffLineKind(lines[index])} diff lines omitted ...]`);
      output.push(lines[index + repeatedRun - 1]);
      omittedLines += repeatedRun - 2;
      index += repeatedRun - 1;
      continue;
    }

    output.push(lines[index]);
  }
  return { lines: output, omittedLines };
}

function looksLikeUnifiedDiff(lines: string[]) {
  return lines.some((line) => line.startsWith("diff --git ")) ||
    (lines.some((line) => line.startsWith("--- ")) && lines.some((line) => line.startsWith("+++ ")) && lines.some(isHunkHeader));
}

function hasUnsafeDiffMarkers(lines: string[]) {
  return lines.some((line) =>
    diffPayload(line).startsWith("<<<<<<<") ||
    diffPayload(line).startsWith("=======") ||
    diffPayload(line).startsWith(">>>>>>>") ||
    line.startsWith("@@@") ||
    line.startsWith("GIT binary patch") ||
    line.startsWith("Binary files ") ||
    line.startsWith("Submodule ")
  );
}

function isHunkHeader(line: string) {
  return /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line);
}

function hunkCounts(lines: string[]) {
  let added = 0;
  let deleted = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deleted += 1;
  }
  return { added, deleted };
}

function contextRunLength(lines: string[], start: number) {
  let length = 0;
  for (let index = start; index < lines.length; index += 1) {
    if (!lines[index].startsWith(" ") || importantDiffLine(lines[index])) break;
    length += 1;
  }
  return length;
}

function repeatedDiffRunLength(lines: string[], start: number) {
  const signature = diffSignature(lines[start]);
  if (!signature) return 0;
  let length = 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (diffSignature(lines[index]) !== signature) break;
    length += 1;
  }
  return length;
}

function diffSignature(line: string) {
  if (importantDiffLine(line)) return undefined;
  const kind = diffLineKind(line);
  if (kind === "metadata") return undefined;
  const normalized = line.slice(1)
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<hash>")
    .replace(/\b\d+(?:\.\d+)?%/g, "<percent>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|B|kB|KB|KiB|MB|MiB|GB|GiB)?\b/g, "<num>")
    .replace(/([_-])\d+\b/g, "$1<num>")
    .replace(/\d+/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length >= 8 ? `${kind}:${normalized}` : undefined;
}

function diffLineKind(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "deleted";
  if (line.startsWith(" ")) return "context";
  return "metadata";
}

function importantDiffLine(line: string) {
  return /\b(?:error|failed|failure|exception|traceback|assertion|fatal|panic|warning|warn)\b/i.test(line) ||
    diffPayload(line).startsWith("<<<<<<<") ||
    diffPayload(line).startsWith("=======") ||
    diffPayload(line).startsWith(">>>>>>>");
}

function diffPayload(line: string) {
  return line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line.slice(1) : line;
}
