export type CreateKeyStepId = "access" | "create" | "verify";

export const createKeySteps: { id: CreateKeyStepId; label: string }[] = [
  { id: "access", label: "Name & models" },
  { id: "create", label: "Create" },
  { id: "verify", label: "Set up & verify" }
];

export type ModelAccessKind = "models" | "profile";

export type CreateKeyDraft = {
  stepId: CreateKeyStepId;
  name: string;
  accessKind: ModelAccessKind;
  modelIds: string[];
  accessProfileId: string;
};

export type CreatedKeyResult = {
  apiKeyId: string | null;
  keyName: string;
  secret: string;
  model: string;
};

export function initialDraft(): CreateKeyDraft {
  return {
    stepId: "access",
    name: "",
    accessKind: "models",
    modelIds: [],
    accessProfileId: ""
  };
}

export function stepBlockerMessage(draft: CreateKeyDraft): string | null {
  if (draft.stepId !== "access") return null;
  if (!draft.name.trim()) return "Enter a key name.";
  if (draft.name.trim().length > 256) return "Key name must be 256 characters or fewer.";
  if (draft.accessKind === "models" && draft.modelIds.length === 0) {
    return "Pick at least one model.";
  }
  if (draft.accessKind === "profile" && !draft.accessProfileId) {
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
