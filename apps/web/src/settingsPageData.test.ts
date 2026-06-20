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
      enabledRules: ["mcp-json-whitespace", "json-whitespace", "bash-output-noise", "shell-command-lossy-summary"],
      storeOriginalArtifact: false,
      storeCompressedArtifact: false
    },
    duplicateToolResultReferences: false,
    costBaseline: {
      anthropicMessagesModel: "claude-fable-5",
      openaiResponsesModel: "gpt-5.5",
      openaiChatModel: "gpt-5.5"
    },
    classifier: { model: "gpt-5-nano", timeoutMs: 4000, maxAttempts: 2, allowRedactedExcerpt: true },
    routeQuality: { lowConfidenceThreshold: 0.55 },
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
      "classifier",
      "capture",
      "quality"
    ]);
  });

  it("drops database-backed sections in file-only mode", () => {
    expect(sectionsFor(false).map((section) => section.id)).toEqual(["classifier", "capture", "quality"]);
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
      classifier: { ...initial.classifier, model: "gpt-6-nano" }
    };
    expect(changedRowIds(settingsSections, edited, initial)).toEqual(["cacheTtlUpgrade", "classifierModel"]);
  });
});

describe("restartPending", () => {
  const restartRequiredFor = ["classifier", "routeQuality"];

  it("flags edits inside restart-gated sections", () => {
    const initial = makeSettings();
    const edited = { ...initial, classifier: { ...initial.classifier, timeoutMs: 9000 } };
    expect(restartPending(settingsSections, restartRequiredFor, edited, initial)).toBe(true);
  });

  it("ignores edits in sections that apply immediately", () => {
    const initial = makeSettings();
    const edited = { ...initial, promptCapture: { ...initial.promptCapture, retentionDays: 7 } };
    expect(restartPending(settingsSections, restartRequiredFor, edited, initial)).toBe(false);
  });
});

describe("validate", () => {
  it("accepts the default fixture", () => {
    expect(validate(makeSettings())).toEqual([]);
  });

  it("rejects out-of-range classifier and quality values", () => {
    const settings = makeSettings({
      classifier: { model: " ", timeoutMs: 0, maxAttempts: 9, allowRedactedExcerpt: false },
      routeQuality: { lowConfidenceThreshold: 1.5 }
    });
    expect(validate(settings)).toEqual([
      "Classifier model is required.",
      "Classifier timeout must be between 1 and 30000 ms.",
      "Classifier attempts must be between 1 and 5.",
      "Low confidence threshold must be between 0 and 1."
    ]);
  });
});
