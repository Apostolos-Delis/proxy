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
  return { ...initialDraft(), name: "CI key", stepId, ...overrides };
}

describe("initialDraft", () => {
  it("starts on configure with the default scopes and no bindings", () => {
    const draft = initialDraft();
    expect(draft.stepId).toBe("configure");
    expect(draft.scopes).toEqual(["proxy", "harness_identity"]);
    expect(draft.routingConfigId).toBeNull();
    expect(Object.values(draft.providerBindings)).toEqual([null, null]);
  });
});

describe("stepBlockerMessage", () => {
  it("requires a non-blank name on configure", () => {
    expect(stepBlockerMessage(draftAt("configure", { name: "" }))).toBe("Enter a key name.");
    expect(stepBlockerMessage(draftAt("configure", { name: "   " }))).toBe("Enter a key name.");
  });

  it("requires at least one scope on configure", () => {
    expect(stepBlockerMessage(draftAt("configure", { scopes: [] }))).toBe("Pick at least one scope.");
  });

  it("passes a valid configure step and never blocks later steps", () => {
    expect(stepBlockerMessage(draftAt("configure"))).toBeNull();
    expect(stepBlockerMessage(draftAt("routing", { name: "", scopes: [] }))).toBeNull();
    expect(stepBlockerMessage(draftAt("create"))).toBeNull();
  });
});

describe("step navigation", () => {
  it("walks forward through the steps and stops at the end", () => {
    expect(nextStepId("configure")).toBe("routing");
    expect(nextStepId("routing")).toBe("create");
    expect(nextStepId("create")).toBe("verify");
    expect(nextStepId("verify")).toBeNull();
  });

  it("walks backward through the steps and stops at the start", () => {
    expect(prevStepId("verify")).toBe("create");
    expect(prevStepId("routing")).toBe("configure");
    expect(prevStepId("configure")).toBeNull();
  });
});

describe("canVisitStep", () => {
  it("allows revisiting earlier steps before the key is created", () => {
    const draft = draftAt("create");
    expect(canVisitStep("configure", draft, false)).toBe(true);
    expect(canVisitStep("routing", draft, false)).toBe(true);
    expect(canVisitStep("create", draft, false)).toBe(false);
    expect(canVisitStep("verify", draft, false)).toBe(false);
  });

  it("locks every step except verify once the key is created", () => {
    const draft = draftAt("verify");
    expect(canVisitStep("configure", draft, true)).toBe(false);
    expect(canVisitStep("routing", draft, true)).toBe(false);
    expect(canVisitStep("create", draft, true)).toBe(false);
    expect(canVisitStep("verify", draft, true)).toBe(true);
  });
});

describe("stepRailState", () => {
  it("marks the current step and splits the rest into complete and pending", () => {
    expect(stepRailState("configure", "routing", false)).toBe("complete");
    expect(stepRailState("routing", "routing", false)).toBe("current");
    expect(stepRailState("create", "routing", false)).toBe("pending");
  });

  it("marks every non-current step complete once the key is created", () => {
    expect(stepRailState("configure", "verify", true)).toBe("complete");
    expect(stepRailState("create", "verify", true)).toBe("complete");
    expect(stepRailState("verify", "verify", true)).toBe("current");
  });
});
