import { describe, expect, it } from "vitest";

import {
  canVisitStep,
  initialDraft,
  nextStepId,
  orgDefaultConfigLabel,
  prevStepId,
  stepBlockerMessage,
  stepRailState,
  withCreatedProviderKey,
  withProviderKeyMode,
  type CreateKeyDraft
} from "./wizard";

function draftAt(stepId: CreateKeyDraft["stepId"], overrides: Partial<CreateKeyDraft> = {}): CreateKeyDraft {
  return { ...initialDraft(), name: "CI key", stepId, ...overrides };
}

describe("initialDraft", () => {
  it("starts on configure with the default harnesses and no bindings", () => {
    const draft = initialDraft();
    expect(draft.stepId).toBe("configure");
    expect(draft.harnesses).toEqual(["claude-code", "codex"]);
    expect(draft.routingConfigId).toBeNull();
    expect(draft.linkProviderKeys).toBe(false);
    expect(Object.values(draft.providerBindings)).toEqual([null, null]);
  });
});

describe("withProviderKeyMode", () => {
  it("clears bindings when switching back to the company default", () => {
    const draft = { ...initialDraft(), linkProviderKeys: true };
    draft.providerBindings.anthropic = "acct_1";
    const next = withProviderKeyMode(draft, false);
    expect(next.linkProviderKeys).toBe(false);
    expect(Object.values(next.providerBindings)).toEqual([null, null]);
  });

  it("preserves bindings when switching to own keys", () => {
    const draft = { ...initialDraft(), linkProviderKeys: true };
    draft.providerBindings.anthropic = "acct_1";
    const next = withProviderKeyMode(draft, true);
    expect(next.linkProviderKeys).toBe(true);
    expect(next.providerBindings.anthropic).toBe("acct_1");
  });
});

describe("withCreatedProviderKey", () => {
  it("flips to own keys and binds the new account", () => {
    const next = withCreatedProviderKey(initialDraft(), "anthropic", "acct_new");
    expect(next.linkProviderKeys).toBe(true);
    expect(next.providerBindings.anthropic).toBe("acct_new");
  });

  it("preserves the other provider's existing binding", () => {
    const draft = { ...initialDraft(), linkProviderKeys: true };
    draft.providerBindings.openai = "acct_openai";
    const next = withCreatedProviderKey(draft, "anthropic", "acct_new");
    expect(next.providerBindings.anthropic).toBe("acct_new");
    expect(next.providerBindings.openai).toBe("acct_openai");
  });
});

describe("orgDefaultConfigLabel", () => {
  it("shows the default config's real name", () => {
    expect(orgDefaultConfigLabel({ name: "Default routing config" }))
      .toBe("Default routing config (organization default)");
  });

  it("falls back when no default config exists", () => {
    expect(orgDefaultConfigLabel(null)).toBe("Organization default");
  });
});

describe("stepBlockerMessage", () => {
  it("requires a non-blank name on configure", () => {
    expect(stepBlockerMessage(draftAt("configure", { name: "" }))).toBe("Enter a key name.");
    expect(stepBlockerMessage(draftAt("configure", { name: "   " }))).toBe("Enter a key name.");
  });

  it("requires at least one harness on configure", () => {
    expect(stepBlockerMessage(draftAt("configure", { harnesses: [] }))).toBe("Pick at least one harness.");
  });

  it("passes a valid configure step and never blocks later steps", () => {
    expect(stepBlockerMessage(draftAt("configure"))).toBeNull();
    expect(stepBlockerMessage(draftAt("routing", { name: "" }))).toBeNull();
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
