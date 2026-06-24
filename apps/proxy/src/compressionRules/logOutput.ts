import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";

export type LogOutputCompactionCandidate = {
  encoded: string;
  originalLines: number;
  omittedLines: number;
};

const DEFAULT_SHELL_TOOL_NAMES = ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"];
const FORMAT = "prompt.log-output-compaction.v1";
const MIN_LINES = 80;
const TAIL_LINES = 40;
const IMPORTANT_CONTEXT_LINES = 2;
const MIN_REPEATED_RUN = 4;

export const logOutputCompactionRule = logOutputCompactionRuleForNames(DEFAULT_SHELL_TOOL_NAMES);

export function logOutputCompactionRuleForNames(shellToolNames: readonly string[]): CompressionRule {
  const toolNames = new Set(shellToolNames);
  return {
    label: "log-output-compaction",
    version: 1,
    matches: (toolName) => toolNames.has(toolName),
    filter: ({ content }) => mapTextContent(content, compactLogOutput),
    minBytes: 4096,
    lossy: true
  };
}

export function compactLogOutput(text: string): string | undefined {
  const candidate = logOutputCompactionCandidate(text);
  return candidate?.encoded;
}

export function logOutputCompactionCandidate(text: string): LogOutputCompactionCandidate | undefined {
  const lines = text.split("\n");
  if (looksLikeUnifiedDiff(lines)) return undefined;
  if (lines.length < MIN_LINES && text.length < 4096) return undefined;

  const preserved = preservedLineIndexes(lines);
  const output: string[] = [`[${FORMAT}; originalLines=${lines.length}; originalChars=${text.length}]`];
  let omittedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (preserved.has(index)) {
      output.push(lines[index]);
      continue;
    }
    const run = repeatedNoiseRun(lines, preserved, index);
    if (run.length >= MIN_REPEATED_RUN) {
      output.push(`[... ${run.length} repeated low-signal log lines omitted ...]`);
      omittedLines += run.length;
      index += run.length - 1;
      continue;
    }
    output.push(lines[index]);
  }

  if (omittedLines === 0) return undefined;
  const encoded = output.join("\n");
  if (encoded.length >= text.length) return undefined;
  return { encoded, originalLines: lines.length, omittedLines };
}

function preservedLineIndexes(lines: string[]) {
  const preserved = new Set<number>();
  const tailStart = Math.max(0, lines.length - TAIL_LINES);
  for (let index = tailStart; index < lines.length; index += 1) preserved.add(index);
  for (let index = 0; index < lines.length; index += 1) {
    if (!importantLogLine(lines[index])) continue;
    const start = Math.max(0, index - IMPORTANT_CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + IMPORTANT_CONTEXT_LINES);
    for (let preserveIndex = start; preserveIndex <= end; preserveIndex += 1) preserved.add(preserveIndex);
  }
  return preserved;
}

function repeatedNoiseRun(lines: string[], preserved: Set<number>, start: number) {
  const signature = noiseSignature(lines[start]);
  if (!signature) return { length: 0 };
  let length = 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (preserved.has(index) || noiseSignature(lines[index]) !== signature) break;
    length += 1;
  }
  return { length };
}

function importantLogLine(line: string) {
  return /\b(?:error|failed|failure|exception|traceback|assertion|fatal|panic|warning|warn|deprecated)\b/i.test(line) ||
    /\b(?:exit code|exited with code|command failed|ELIFECYCLE)\b/i.test(line) ||
    /^\s*File ".*", line \d+/.test(line) ||
    /(?:^|\s)(?:at\s+)?[\w./-]+\.(?:ts|tsx|js|jsx|py|rb|rs|go|java|css|json|md):\d+(?::\d+)?/.test(line);
}

function looksLikeUnifiedDiff(lines: string[]) {
  return lines.some((line) => line.startsWith("diff --git ")) ||
    (lines.some((line) => line.startsWith("--- ")) && lines.some((line) => line.startsWith("+++ ")) && lines.some((line) => /^@@\s+-\d/.test(line)));
}

function noiseSignature(line: string) {
  if (importantLogLine(line)) return undefined;
  const trimmed = line.trim();
  if (trimmed.length < 8) return undefined;
  const normalized = trimmed
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<hash>")
    .replace(/\b\d+(?:\.\d+)?%/g, "<percent>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|B|kB|KB|KiB|MB|MiB|GB|GiB)?\b/g, "<num>")
    .replace(/([_-])\d+\b/g, "$1<num>")
    .replace(/\s+/g, " ");
  return normalized.length >= 8 ? normalized : undefined;
}
