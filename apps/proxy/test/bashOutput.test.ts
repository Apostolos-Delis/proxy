import { describe, expect, it } from "vitest";

import { bashOutputRule } from "../src/compressionRules/bashOutput.js";

const ESC = String.fromCharCode(27); // "";

function run(toolName: string, content: unknown) {
  return bashOutputRule.filter({ toolName, toolInput: undefined, content });
}

describe("bashOutputRule", () => {
  it("matches shell tool names only", () => {
    expect(bashOutputRule.matches("Bash")).toBe(true);
    expect(bashOutputRule.matches("shell")).toBe(true);
    expect(bashOutputRule.matches("local_shell")).toBe(true);
    expect(bashOutputRule.matches("mcp__x__y")).toBe(false);
    expect(bashOutputRule.matches("Read")).toBe(false);
  });

  it("strips CSI color escape sequences", () => {
    const colored = `${ESC}[32mPASS${ESC}[0m all tests green`;
    const result = run("Bash", colored) as string;
    expect(result).toBe("PASS all tests green");
  });

  it("strips OSC sequences terminated by BEL or ESC backslash", () => {
    const titled = `${ESC}]0;my-titledone`;
    const result = run("Bash", titled) as string;
    expect(result).toBe("done");
  });

  it("collapses carriage-return progress lines to the final state", () => {
    const progress = "Downloading\r 10%\r 50%\r 100% complete\nNext line";
    const result = run("Bash", progress) as string;
    expect(result).toBe(" 100% complete\nNext line");
  });

  it("preserves all lines of CRLF output (treats \\r\\n as a line ending, not an overwrite)", () => {
    // Under a PTY the kernel turns every \n into \r\n; these are real lines.
    const crlf = "line1\r\nline2\r\nline3";
    const result = run("Bash", crlf) as string;
    expect(result).toBe("line1\nline2\nline3");
  });

  it("preserves CRLF lines while still stripping color (PTY capture shape)", () => {
    const log = `${ESC}[32mok line1${ESC}[0m\r\n${ESC}[32mok line2${ESC}[0m\r\ndone`;
    const result = run("Bash", log) as string;
    expect(result).toBe("ok line1\nok line2\ndone");
  });

  it("does not touch ordinary bracketed text (only ESC-anchored sequences)", () => {
    const code = "arr[0] = list[index]; obj[key]++";
    expect(run("Bash", code)).toBeUndefined(); // no noise → no shrink → no change
  });

  it("preserves real output content while stripping color", () => {
    const log = `${ESC}[31mERROR${ESC}[0m: file not found at /path/to/x.ts:42`;
    const result = run("Bash", log) as string;
    expect(result).toBe("ERROR: file not found at /path/to/x.ts:42");
  });

  it("handles Claude Code text-block array content", () => {
    const result = run("Bash", [{ type: "text", text: `${ESC}[1mbuild ok${ESC}[0m` }]) as Array<{ text: string }>;
    expect(result[0].text).toBe("build ok");
  });

  it("returns undefined when there is no noise to strip", () => {
    expect(run("Bash", "plain output with no escapes")).toBeUndefined();
  });

  it("is deterministic", () => {
    const input = `${ESC}[32mok\r retry\r done${ESC}[0m`;
    expect(run("Bash", input)).toBe(run("Bash", input));
  });
});
