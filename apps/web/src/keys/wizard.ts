import type { ProviderName } from "../providers/data";
import { PROVIDER_ORDER } from "../providers";

export type CreateKeyStepId = "configure" | "routing" | "create" | "verify";

export const createKeySteps: { id: CreateKeyStepId; label: string }[] = [
  { id: "configure", label: "Configure" },
  { id: "routing", label: "Routing" },
  { id: "create", label: "Create" },
  { id: "verify", label: "Set up & verify" }
];

export type CreateKeyDraft = {
  stepId: CreateKeyStepId;
  name: string;
  scopes: string[];
  routingConfigId: string | null;
  linkProviderKeys: boolean;
  providerBindings: Record<ProviderName, string | null>;
};

export type CreatedKeyResult = {
  apiKeyId: string | null;
  keyName: string;
  secret: string;
  bindingFailures: string[];
};

export function initialDraft(): CreateKeyDraft {
  return {
    stepId: "configure",
    name: "",
    scopes: ["proxy", "harness_identity"],
    routingConfigId: null,
    linkProviderKeys: false,
    providerBindings: emptyProviderBindings()
  };
}

function emptyProviderBindings() {
  return Object.fromEntries(
    PROVIDER_ORDER.map((provider) => [provider, null])
  ) as Record<ProviderName, string | null>;
}

// Switching back to the platform keys clears any per-provider picks so the
// submit payload can never carry bindings the user deselected.
export function withProviderKeyMode(draft: CreateKeyDraft, linkProviderKeys: boolean): CreateKeyDraft {
  if (linkProviderKeys) return { ...draft, linkProviderKeys };
  return { ...draft, linkProviderKeys, providerBindings: emptyProviderBindings() };
}

// A key created mid-wizard flips the draft to own-keys mode and binds itself,
// leaving the other providers' picks untouched.
export function withCreatedProviderKey(
  draft: CreateKeyDraft,
  provider: ProviderName,
  providerAccountId: string
): CreateKeyDraft {
  const next = withProviderKeyMode(draft, true);
  return { ...next, providerBindings: { ...next.providerBindings, [provider]: providerAccountId } };
}

// A null routingConfigId resolves server-side to the seeded default config,
// so surface its real name instead of an opaque "Organization default".
export function orgDefaultConfigLabel(defaultConfig: { name: string } | null): string {
  return defaultConfig ? `${defaultConfig.name} (organization default)` : "Organization default";
}

export function stepBlockerMessage(draft: CreateKeyDraft): string | null {
  if (draft.stepId !== "configure") return null;
  if (!draft.name.trim()) return "Enter a key name.";
  if (draft.scopes.length === 0) return "Pick at least one scope.";
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
