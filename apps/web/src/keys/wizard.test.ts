import { describe, expect, it } from "vitest";

import {
  canVisitStep,
  initialDraft,
  nextStepId,
  prevStepId,
  stepBlockerMessage,
  stepRailState,
  type CreateKeyDraft
} from "./wizard";

function draftAt(stepId: CreateKeyDraft["stepId"], overrides: Partial<CreateKeyDraft> = {}): CreateKeyDraft {
  return { ...initialDraft(), name: "CI key", modelIds: ["model_1"], stepId, ...overrides };
}

describe("initialDraft", () => {
  it("starts on access in pick-models mode with nothing selected", () => {
    const draft = initialDraft();
    expect(draft.stepId).toBe("access");
    expect(draft.accessKind).toBe("models");
    expect(draft.modelIds).toEqual([]);
    expect(draft.accessProfileId).toBe("");
  });
});

describe("stepBlockerMessage", () => {
  it("requires a non-blank name on access", () => {
    expect(stepBlockerMessage(draftAt("access", { name: "" }))).toBe("Enter a key name.");
    expect(stepBlockerMessage(draftAt("access", { name: "   " }))).toBe("Enter a key name.");
    expect(stepBlockerMessage(draftAt("access", { name: "x".repeat(257) }))).toMatch(/256/);
  });

  it("requires at least one model in pick-models mode", () => {
    expect(stepBlockerMessage(draftAt("access", { modelIds: [] }))).toBe("Pick at least one model.");
    expect(stepBlockerMessage(draftAt("access"))).toBeNull();
  });

  it("requires a profile in existing-profile mode", () => {
    expect(stepBlockerMessage(draftAt("access", { accessKind: "profile" }))).toBe("Pick an access profile.");
    expect(stepBlockerMessage(draftAt("access", { accessKind: "profile", accessProfileId: "profile_1" }))).toBeNull();
    expect(stepBlockerMessage(draftAt("create", { modelIds: [] }))).toBeNull();
  });
});

describe("step navigation", () => {
  it("walks forward through the steps and stops at the end", () => {
    expect(nextStepId("access")).toBe("create");
    expect(nextStepId("create")).toBe("verify");
    expect(nextStepId("verify")).toBeNull();
  });

  it("walks backward through the steps and stops at the start", () => {
    expect(prevStepId("verify")).toBe("create");
    expect(prevStepId("create")).toBe("access");
    expect(prevStepId("access")).toBeNull();
  });
});

describe("canVisitStep", () => {
  it("allows revisiting earlier steps before the key is created", () => {
    const draft = draftAt("create");
    expect(canVisitStep("access", draft, false)).toBe(true);
    expect(canVisitStep("create", draft, false)).toBe(false);
    expect(canVisitStep("verify", draft, false)).toBe(false);
  });

  it("locks every step except verify once the key is created", () => {
    const draft = draftAt("verify");
    expect(canVisitStep("access", draft, true)).toBe(false);
    expect(canVisitStep("create", draft, true)).toBe(false);
    expect(canVisitStep("verify", draft, true)).toBe(true);
  });
});

describe("stepRailState", () => {
  it("marks the current step and splits the rest into complete and pending", () => {
    expect(stepRailState("access", "create", false)).toBe("complete");
    expect(stepRailState("create", "create", false)).toBe("current");
    expect(stepRailState("verify", "create", false)).toBe("pending");
  });

  it("marks every non-current step complete once the key is created", () => {
    expect(stepRailState("access", "verify", true)).toBe("complete");
    expect(stepRailState("create", "verify", true)).toBe("complete");
    expect(stepRailState("verify", "verify", true)).toBe("current");
  });
});
