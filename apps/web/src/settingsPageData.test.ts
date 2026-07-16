import { describe, expect, it } from "vitest";

import {
  changedRowIds,
  filterSections,
  restartPending,
  sectionsFor,
  settingsSections,
  validate,
  type EditableSettings
} from "./settingsPageData";

function makeSettings(overrides: Partial<EditableSettings> = {}): EditableSettings {
  return {
    schemaVersion: 1,
    systemPrompt: null,
    cacheTtlUpgrade: false,
    automaticCaching: false,
    toolResultCompressionPolicy: {
      mode: "disabled",
      minOriginalBytes: 512,
      minSavingsTokens: 0,
      enabledRules: ["search-result-grouping", "diff-compaction", "log-output-compaction", "json-array-compaction", "mcp-json-whitespace", "json-whitespace", "bash-output-noise", "shell-command-lossy-summary"],
      storeOriginalArtifact: false,
      storeCompressedArtifact: false
    },
    duplicateToolResultReferences: false,
    costBaseline: {
      anthropicMessagesModel: "claude-fable-5",
      openaiResponsesModel: "gpt-5.5",
      openaiChatModel: "gpt-5.5"
    },
    promptCapture: { promptCaptureMode: "raw_text", retentionDays: 30 },
    ...overrides
  };
}

describe("sectionsFor", () => {
  it("includes every section when the database is enabled", () => {
    expect(sectionsFor(true).map((section) => section.id)).toEqual([
      "system",
      "optimization",
      "baseline",
      "capture"
    ]);
  });

  it("drops database-backed sections in file-only mode", () => {
    expect(sectionsFor(false).map((section) => section.id)).toEqual(["capture"]);
  });
});

describe("settings copy", () => {
  it("does not claim Proxy always applies OpenAI cache retention", () => {
    const optimization = settingsSections.find((section) => section.id === "optimization");

    expect(optimization?.description).toContain("explicit prompt_cache_retention values are forwarded to public OpenAI upstreams");
    expect(optimization?.description).not.toContain("always get 24-hour prompt-cache retention");
  });
});

describe("filterSections", () => {
  it("returns sections unchanged for an empty query", () => {
    expect(filterSections(settingsSections, "  ")).toBe(settingsSections);
  });

  it("filters to rows whose label or description matches", () => {
    const result = filterSections(settingsSections, "cache ttl");
    expect(result.map((section) => section.id)).toEqual(["optimization"]);
    expect(result[0]?.rows.map((row) => row.id)).toEqual(["cacheTtlUpgrade"]);
  });

  it("matches the section title so a section query keeps all its rows", () => {
    const result = filterSections(settingsSections, "prompt capture");
    expect(result.map((section) => section.id)).toEqual(["capture"]);
    expect(result[0]?.rows).toHaveLength(2);
  });

  it("returns no sections when nothing matches", () => {
    expect(filterSections(settingsSections, "zzzzz")).toEqual([]);
  });
});

describe("row accessors", () => {
  it("every row's set is read back by its get", () => {
    const base = makeSettings();
    for (const section of settingsSections) {
      for (const row of section.rows) {
        if (row.type === "toggle") {
          const flipped = !row.get(base);
          expect(row.get(row.set(base, flipped))).toBe(flipped);
        } else if (row.type === "number") {
          const sample = row.min + (row.step ?? 1);
          expect(row.get(row.set(base, sample))).toBe(sample);
        } else if (row.type === "select") {
          const next = row.options.find((option) => option.value !== row.get(base));
          expect(next).toBeDefined();
          expect(row.get(row.set(base, next?.value ?? ""))).toBe(next?.value ?? "");
        } else {
          expect(row.get(row.set(base, "edited"))).toBe("edited");
        }
      }
    }
  });
});

describe("changedRowIds", () => {
  it("is empty when nothing changed", () => {
    const settings = makeSettings();
    expect(changedRowIds(settingsSections, settings, makeSettings())).toEqual([]);
  });

  it("reports exactly the edited rows, including nested fields", () => {
    const initial = makeSettings();
    const edited = {
      ...initial,
      cacheTtlUpgrade: true,
      promptCapture: { ...initial.promptCapture, retentionDays: 7 }
    };
    expect(changedRowIds(settingsSections, edited, initial)).toEqual(["cacheTtlUpgrade", "promptRetentionDays"]);
  });
});

describe("restartPending", () => {
  it("returns false because active settings apply immediately", () => {
    const initial = makeSettings();
    const edited = { ...initial, promptCapture: { ...initial.promptCapture, retentionDays: 7 } };
    expect(restartPending(settingsSections, [], edited, initial)).toBe(false);
  });
});

describe("validate", () => {
  it("accepts the default fixture", () => {
    expect(validate(makeSettings())).toEqual([]);
  });

  it("rejects an invalid prompt retention", () => {
    const settings = makeSettings({ promptCapture: { promptCaptureMode: "raw_text", retentionDays: -1 } });
    expect(validate(settings)).toEqual(["Prompt retention must be zero or more days."]);
  });
});
