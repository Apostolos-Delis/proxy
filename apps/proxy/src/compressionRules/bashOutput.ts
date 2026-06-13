import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";

// Deterministic noise-stripping for shell tool output. Terminal output carries
// formatting the model does not need: ANSI color/cursor escape sequences, and
// carriage-return "progress" lines (download bars, spinners) that overwrite
// themselves in a real terminal but accumulate as separate lines in captured
// output. Removing them is lossless for the information the model reasons over
// while reclaiming real tokens on install/build/test logs.
//
// We do NOT drop or summarize actual output lines — that would be lossy and
// command-specific guesswork. This stays a pure function of the input bytes.

// Per harness: Bash (Claude Code), shell/local_shell (Codex), run_terminal_cmd (Cursor).
const SHELL_TOOL_NAMES = ["Bash", "shell", "local_shell", "run_terminal_cmd"];

// ANSI escape sequences, every alternative anchored on the ESC control byte
// () so only true escape sequences match — never ordinary bracketed text.
// Built via RegExp from string escapes to keep raw control bytes out of source.
//   - CSI:    ESC [ ... final-byte      (colors, cursor moves)
//   - OSC:    ESC ] ... (BEL | ESC \)   (window titles, hyperlinks)
//   - 2-char: ESC <single byte>
const ANSI_PATTERN = new RegExp(
  "\\u001b\\[[0-9;?]*[ -/]*[@-~]" +
    "|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)" +
    "|\\u001b[@-Z\\\\-_]",
  "g"
);

export const bashOutputRule = bashOutputRuleForNames(SHELL_TOOL_NAMES);

export function bashOutputRuleForNames(names: readonly string[]): CompressionRule {
  const toolNames = new Set(names);
  return {
    label: "bash-output-noise",
    version: 1,
    matches: (toolName) => toolNames.has(toolName),
    filter: ({ content }) => mapTextContent(content, stripNoise),
    // Cheap O(n) scan — worth running on mid-size outputs too.
    minChars: 512
  };
}

function stripNoise(text: string): string | undefined {
  const result = collapseCarriageReturns(text.replace(ANSI_PATTERN, ""));
  return result.length < text.length ? result : undefined;
}

// Within each newline-delimited line, a carriage return means the cursor
// returned to column 0 and subsequent text overwrote what came before. Keep
// only the text after the final carriage return on each line — the state a
// terminal would actually display.
//
// A CRLF (\r\n) is a line terminator, NOT an overwrite: under a PTY the kernel
// translates every \n to \r\n (ONLCR), which is exactly the case where ANSI
// color appears. We must treat the trailing \r as part of the line ending so
// CRLF logs are not gutted — only a true mid-line \r collapses content.
function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      const body = line.endsWith("\r") ? line.slice(0, -1) : line;
      const carriage = body.lastIndexOf("\r");
      return carriage === -1 ? body : body.slice(carriage + 1);
    })
    .join("\n");
}
