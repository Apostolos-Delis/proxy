import { defaultHarnessSetupSelection, type HarnessSetupSelection } from "./setupSnippets";

export type CreateKeyStepId = "configure" | "routing" | "create" | "verify";

export const createKeySteps: { id: CreateKeyStepId; label: string }[] = [
  { id: "configure", label: "Configure" },
  { id: "routing", label: "Access" },
  { id: "create", label: "Create" },
  { id: "verify", label: "Set up & verify" }
];

export type CreateKeyDraft = {
  stepId: CreateKeyStepId;
  name: string;
  harnesses: HarnessSetupSelection;
  accessProfileId: string;
};

export type CreatedKeyResult = {
  apiKeyId: string | null;
  keyName: string;
  harnesses: HarnessSetupSelection;
  secret: string;
  model: string;
};

export function initialDraft(): CreateKeyDraft {
  return {
    stepId: "configure",
    name: "",
    harnesses: [...defaultHarnessSetupSelection],
    accessProfileId: ""
  };
}

export function stepBlockerMessage(draft: CreateKeyDraft): string | null {
  if (draft.stepId === "configure") {
    if (!draft.name.trim()) return "Enter a key name.";
    if (draft.harnesses.length === 0) return "Pick at least one harness.";
  }
  if (draft.stepId === "routing" && !draft.accessProfileId) {
    return "Pick an access profile.";
  }
  return null;
}

export function nextStepId(stepId: CreateKeyStepId): CreateKeyStepId | null {
  const index = stepIndex(stepId);
  return createKeySteps[index + 1]?.id ?? null;
}

export function prevStepId(stepId: CreateKeyStepId): CreateKeyStepId | null {
  const index = stepIndex(stepId);
  return createKeySteps[index - 1]?.id ?? null;
}

// Before the key exists the rail allows revisiting earlier steps; once the
// secret has been issued the inputs are immutable, so only verify remains.
export function canVisitStep(stepId: CreateKeyStepId, draft: CreateKeyDraft, created: boolean) {
  if (created) return stepId === "verify";
  return stepIndex(stepId) < stepIndex(draft.stepId);
}

export function stepRailState(stepId: CreateKeyStepId, currentStepId: CreateKeyStepId, created: boolean) {
  if (stepId === currentStepId) return "current";
  if (created || stepIndex(stepId) < stepIndex(currentStepId)) return "complete";
  return "pending";
}

function stepIndex(stepId: CreateKeyStepId) {
  return createKeySteps.findIndex((step) => step.id === stepId);
}
