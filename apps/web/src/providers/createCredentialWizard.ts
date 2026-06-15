import type { ProviderAccountAuthType } from "../gql/graphql";
import type { ProviderName } from "./data";

export type CreateProviderCredentialMode = "api_key" | "claude_subscription" | "codex_subscription";
export type CreateProviderCredentialStepId = "type" | "credentials" | "review" | "bind";

export type CreateProviderCredentialDraft = {
  stepId: CreateProviderCredentialStepId;
  mode: CreateProviderCredentialMode;
  provider: ProviderName;
  name: string;
  apiKey: string;
  baseUrl: string;
  chatgptAccountId: string;
};

export const SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat01-";

export const createProviderCredentialSteps: { id: CreateProviderCredentialStepId; label: string }[] = [
  { id: "type", label: "Type" },
  { id: "credentials", label: "Credentials" },
  { id: "review", label: "Create" },
  { id: "bind", label: "Bind" }
];

export function initialProviderCredentialDraft(): CreateProviderCredentialDraft {
  return {
    stepId: "type",
    mode: "api_key",
    provider: "anthropic",
    name: "",
    apiKey: "",
    baseUrl: "",
    chatgptAccountId: ""
  };
}

export function withCredentialMode(
  draft: CreateProviderCredentialDraft,
  mode: CreateProviderCredentialMode
): CreateProviderCredentialDraft {
  return {
    ...draft,
    mode,
    provider: providerForMode(mode, draft.provider),
    chatgptAccountId: mode === "codex_subscription" ? draft.chatgptAccountId : ""
  };
}

export function authTypeForMode(mode: CreateProviderCredentialMode): ProviderAccountAuthType {
  return mode === "api_key" ? "api_key" : "oauth";
}

export function providerForMode(mode: CreateProviderCredentialMode, currentProvider: ProviderName): ProviderName {
  if (mode === "claude_subscription") return "anthropic";
  if (mode === "codex_subscription") return "openai";
  return currentProvider;
}

export function credentialModeLabel(mode: CreateProviderCredentialMode) {
  if (mode === "claude_subscription") return "Claude subscription";
  if (mode === "codex_subscription") return "Codex subscription";
  return "Provider API key";
}

export function secretLabelForDraft(draft: CreateProviderCredentialDraft) {
  if (draft.mode === "claude_subscription") return "Claude setup token";
  if (draft.mode === "codex_subscription") return "Codex access token or auth JSON";
  return "API key";
}

export function secretPlaceholderForDraft(draft: CreateProviderCredentialDraft) {
  if (draft.mode === "claude_subscription") return `${SUBSCRIPTION_TOKEN_PREFIX}...`;
  if (draft.mode === "codex_subscription") return "Paste access token or auth JSON";
  return draft.provider === "openai" ? "sk-proj-..." : "sk-ant-...";
}

export function namePlaceholderForDraft(draft: CreateProviderCredentialDraft) {
  if (draft.mode === "claude_subscription") return "My Claude Max subscription";
  if (draft.mode === "codex_subscription") return "My ChatGPT Codex access";
  return "Acme Corp Anthropic key";
}

export function stepBlockerMessage(
  draft: CreateProviderCredentialDraft,
  subscriptionAuthEnabled: boolean
): string | null {
  if (draft.stepId === "type" && draft.mode !== "api_key" && !subscriptionAuthEnabled) {
    return "Enable subscription auth before creating subscription credentials.";
  }
  if (draft.stepId !== "credentials") return null;
  return credentialBlockerMessage(draft, subscriptionAuthEnabled);
}

export function credentialBlockerMessage(
  draft: CreateProviderCredentialDraft,
  subscriptionAuthEnabled: boolean
): string | null {
  if (!draft.name.trim()) return "Enter a credential label.";
  if (!draft.apiKey.trim()) return `${secretLabelForDraft(draft)} is required.`;
  if (draft.mode !== "api_key" && !subscriptionAuthEnabled) {
    return "Subscription auth has been disabled for this proxy.";
  }
  if (draft.mode === "claude_subscription" && !draft.apiKey.trim().startsWith(SUBSCRIPTION_TOKEN_PREFIX)) {
    return `Claude setup tokens start with ${SUBSCRIPTION_TOKEN_PREFIX}`;
  }
  if (draft.mode === "codex_subscription") {
    const authJsonError = codexAuthJsonError(draft.apiKey);
    if (authJsonError) return authJsonError;
    if (!draft.chatgptAccountId.trim() && !codexAuthJsonHasAccountId(draft.apiKey)) {
      return "ChatGPT account ID is required unless the auth JSON includes one.";
    }
  }
  return null;
}

export function nextStepId(stepId: CreateProviderCredentialStepId): CreateProviderCredentialStepId | null {
  const index = stepIndex(stepId);
  return createProviderCredentialSteps[index + 1]?.id ?? null;
}

export function prevStepId(stepId: CreateProviderCredentialStepId): CreateProviderCredentialStepId | null {
  const index = stepIndex(stepId);
  return createProviderCredentialSteps[index - 1]?.id ?? null;
}

export function canVisitStep(
  stepId: CreateProviderCredentialStepId,
  draft: CreateProviderCredentialDraft,
  created: boolean
) {
  if (created) return stepId === "bind";
  return stepIndex(stepId) < stepIndex(draft.stepId);
}

export function stepRailState(
  stepId: CreateProviderCredentialStepId,
  currentStepId: CreateProviderCredentialStepId,
  created: boolean
) {
  if (stepId === currentStepId) return "current";
  if (created || stepIndex(stepId) < stepIndex(currentStepId)) return "complete";
  return "pending";
}

function codexAuthJsonError(input: string) {
  const value = input.trim();
  if (!value.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "Paste valid Codex auth JSON or a raw access token.";
  }
  if (!isRecord(parsed)) return "Paste valid Codex auth JSON or a raw access token.";
  if (!codexAuthJsonAccessToken(parsed)) return "Codex auth JSON must include an access token.";
  return null;
}

function codexAuthJsonHasAccountId(input: string) {
  const value = input.trim();
  if (!value.startsWith("{")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  const record = parsed;
  return Boolean(stringValue(record.chatgpt_account_id) ?? stringValue(record.chatgptAccountId) ?? stringValue(record.account_id) ?? stringValue(record.accountId));
}

function codexAuthJsonAccessToken(parsed: Record<string, unknown>) {
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  return stringValue(parsed.access_token) ?? stringValue(parsed.accessToken) ??
    stringValue(tokens?.access_token) ?? stringValue(tokens?.accessToken);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stepIndex(stepId: CreateProviderCredentialStepId) {
  return createProviderCredentialSteps.findIndex((step) => step.id === stepId);
}
