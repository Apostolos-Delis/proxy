import { describe, expect, it } from "vitest";

import { displayDatabaseUrl } from "./consoleContext.js";
import { formatRunnerResult, parseRunnerArgs, runSource } from "./runnerCore.js";

describe("database runner", () => {
  it("parses inline source", () => {
    expect(parseRunnerArgs(["await", "db.select()"])).toEqual({
      mode: "source",
      input: "await db.select()",
      json: true
    });
  });

  it("parses file mode", () => {
    expect(parseRunnerArgs(["--inspect", "--file", "./task.ts"])).toEqual({
      mode: "file",
      input: "./task.ts",
      json: false
    });
  });

  it("skips forwarded argument separators and parses help", () => {
    expect(parseRunnerArgs(["--", "--help"])).toEqual({
      mode: "help",
      input: "",
      json: true
    });
  });

  it("runs expressions and statements against provided bindings", async () => {
    await expect(runSource({ value: 2 }, "await Promise.resolve(value + 3)")).resolves.toBe(5);
    await expect(runSource({ value: 2 }, "const next = value + 4; return next;")).resolves.toBe(6);
  });

  it("formats JSON with bigint values", () => {
    expect(formatRunnerResult({ id: 1n }, true)).toBe("{\n  \"id\": \"1\"\n}");
    expect(formatRunnerResult(undefined, true)).toBeNull();
  });

  it("redacts database URL credentials for display", () => {
    expect(displayDatabaseUrl("postgres://user:secret@localhost:5432/db")).toBe(
      "postgres://REDACTED:REDACTED@localhost:5432/db"
    );
  });
});
