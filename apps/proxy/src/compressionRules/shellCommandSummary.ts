import { isRecord } from "../util.js";
import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";

const SHELL_TOOL_NAMES = ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"];

export type ShellCommandClass =
  | "git_diff"
  | "git_status"
  | "grep_rg"
  | "find_fd"
  | "ls_tree"
  | "test_output"
  | "build_output"
  | "package_install"
  | "generic_log"
  | "unknown";

export const shellCommandSummaryRule: CompressionRule = {
  label: "shell-command-lossy-summary",
  version: 1,
  lossy: true,
  matches: (toolName) => SHELL_TOOL_NAMES.includes(toolName),
  filter: ({ content, toolInput }) =>
    mapTextContent(content, (text) => summarizeShellOutput(text, classifyShellCommand(toolInput, text))),
  minBytes: 4096
};

export function classifyShellCommand(toolInput: unknown, output = ""): ShellCommandClass {
  const command = shellCommandFromInput(toolInput)?.trim();
  if (command) {
    if (/\bgit\s+(?:-[^\s]+\s+)*diff\b/.test(command)) return "git_diff";
    if (/\bgit\s+(?:-[^\s]+\s+)*status\b/.test(command)) return "git_status";
    if (/^(?:\S+=\S+\s+)*(?:rg|grep)\b/.test(command)) return "grep_rg";
    if (/^(?:\S+=\S+\s+)*(?:find|fd)\b/.test(command)) return "find_fd";
    if (/^(?:\S+=\S+\s+)*(?:ls|tree)\b/.test(command)) return "ls_tree";
    if (/(?:^|\s)(?:pytest|vitest|jest|mocha|rspec|go test|cargo test|pnpm test|npm test|yarn test)\b/.test(command)) return "test_output";
    if (/(?:^|\s)(?:tsc|eslint|webpack|vite build|next build|pnpm build|npm run build|yarn build|cargo build)\b/.test(command)) return "build_output";
    if (/(?:^|\s)(?:pnpm install|npm install|yarn install|pip install|bundle install|cargo fetch)\b/.test(command)) return "package_install";
  }
  if (/\b(?:FAIL|FAILED|Traceback|AssertionError|error TS\d+|ESLint|TypeError|Exception)\b/.test(output)) return "test_output";
  if (/\b(?:webpack|vite|tsc|build failed|Compilation failed)\b/i.test(output)) return "build_output";
  if (/\b(?:added \d+ packages|resolved \d+|downloaded|installed)\b/i.test(output)) return "package_install";
  if (output.trim().length > 0) return "generic_log";
  return "unknown";
}

export function shellCommandFromInput(toolInput: unknown): string | undefined {
  if (typeof toolInput === "string") {
    const parsed = parseJsonObject(toolInput);
    return stringCommand(parsed) ?? toolInput;
  }
  return stringCommand(toolInput);
}

function summarizeShellOutput(text: string, commandClass: ShellCommandClass): string | undefined {
  if (commandClass === "unknown") return undefined;
  if (hasConflictMarkers(text)) return undefined;
  const lines = text.split("\n");
  if (lines.length < 40 && text.length < 4096) return undefined;
  const important = lines.filter(importantShellLine);
  const retained = uniqueLines([...important.slice(-80), ...lines.slice(-40)]);
  const summary = [
    `[prompt lossy shell summary; commandClass=${commandClass}; originalLines=${lines.length}; originalChars=${text.length}]`,
    ...retained
  ].join("\n");
  return summary.length < text.length ? summary : undefined;
}

function hasConflictMarkers(text: string) {
  return /^[ +-]?(?:<<<<<<<|=======|>>>>>>>)/m.test(text);
}

function importantShellLine(line: string) {
  return /\b(?:error|failed|failure|exception|traceback|assertion|fatal|panic|warning|warn)\b/i.test(line) ||
    /(?:^|\s)(?:at\s+)?[\w./-]+\.(?:ts|tsx|js|jsx|py|rb|rs|go|java|css|json|md):\d+(?::\d+)?/.test(line) ||
    /^[-+]{3}\s|^@@\s|^\s*(?:modified|deleted|new file|renamed):/.test(line);
}

function uniqueLines(lines: string[]) {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

function stringCommand(value: unknown) {
  if (!isRecord(value)) return undefined;
  const command = value.command ?? value.cmd ?? value.script;
  return typeof command === "string" ? command : undefined;
}

function parseJsonObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
