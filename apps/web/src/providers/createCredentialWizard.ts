import type { ProviderAccountAuthType } from "../gql/graphql";
import type { ProviderName } from "./data";

export type CreateProviderCredentialMode = "api_key" | "claude_subscription" | "codex_subscription";
export type CreateProviderCredentialSource = "claude_oauth" | "openai_oauth" | "local_auth" | "manual";
export type CreateProviderCredentialStepId = "type" | "credentials" | "review" | "bind";
export type BedrockCredentialMode = "aws_bedrock_bearer_token" | "aws_static_keys" | "aws_default_chain" | "aws_profile";

export type CreateProviderCredentialDraft = {
  stepId: CreateProviderCredentialStepId;
  mode: CreateProviderCredentialMode;
  provider: ProviderName;
  name: string;
  apiKey: string;
  baseUrl: string;
  chatgptAccountId: string;
  source: CreateProviderCredentialSource;
  bedrockCredentialMode: BedrockCredentialMode;
  bedrockRegion: string;
  bedrockEndpointOverride: string;
  bedrockDiscoveryRegions: string;
  bedrockAccessKeyId: string;
  bedrockSecretAccessKey: string;
  bedrockSessionToken: string;
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
    chatgptAccountId: "",
    source: "manual",
    bedrockCredentialMode: "aws_bedrock_bearer_token",
    bedrockRegion: "us-east-1",
    bedrockEndpointOverride: "",
    bedrockDiscoveryRegions: "us-east-1",
    bedrockAccessKeyId: "",
    bedrockSecretAccessKey: "",
    bedrockSessionToken: ""
  };
}

export function withCredentialMode(
  draft: CreateProviderCredentialDraft,
  mode: CreateProviderCredentialMode
): CreateProviderCredentialDraft {
  const source = mode === "api_key" ? "manual" : subscriptionSourceForModeChange(draft, mode);
  const modeChanged = draft.mode !== mode;
  const browserOAuth = source === "claude_oauth" || source === "openai_oauth";
  return {
    ...draft,
    mode,
    provider: providerForMode(mode, draft.provider),
    apiKey: modeChanged ? "" : draft.apiKey,
    baseUrl: browserOAuth ? "" : draft.baseUrl,
    chatgptAccountId: mode === "codex_subscription" && source === "manual" && !modeChanged ? draft.chatgptAccountId : "",
    source
  };
}

export function withCredentialSource(
  draft: CreateProviderCredentialDraft,
  source: CreateProviderCredentialSource
): CreateProviderCredentialDraft {
  return {
    ...draft,
    source,
    apiKey: source === "manual" ? draft.apiKey : "",
    baseUrl: source === "claude_oauth" || source === "openai_oauth" ? "" : draft.baseUrl,
    chatgptAccountId: source === "manual" ? draft.chatgptAccountId : ""
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

export function bedrockCredentialModeLabel(mode: BedrockCredentialMode) {
  if (mode === "aws_bedrock_bearer_token") return "Bedrock bearer token";
  if (mode === "aws_static_keys") return "AWS static keys";
  if (mode === "aws_default_chain") return "Deployment default chain";
  return "Configured AWS profile";
}

export function secretLabelForDraft(draft: CreateProviderCredentialDraft) {
  if (draft.source === "claude_oauth" && draft.mode === "claude_subscription") return "Claude sign-in token";
  if (draft.source === "openai_oauth" && draft.mode === "codex_subscription") return "OpenAI sign-in";
  if (draft.source === "local_auth" && draft.mode === "claude_subscription") return "Imported Claude setup token";
  if (draft.source === "local_auth" && draft.mode === "codex_subscription") return "Imported Codex auth";
  if (draft.mode === "claude_subscription") return "Claude setup token";
  if (draft.mode === "codex_subscription") return "Codex access token or auth JSON";
  return "API key";
}

export function sourceLabelForDraft(draft: CreateProviderCredentialDraft) {
  if (draft.source === "claude_oauth" && draft.mode === "claude_subscription") return "Claude browser sign-in";
  if (draft.source === "openai_oauth" && draft.mode === "codex_subscription") return "OpenAI device sign-in";
  if (draft.source === "local_auth" && draft.mode === "claude_subscription") return "Local Claude setup-token import";
  if (draft.source === "local_auth" && draft.mode === "codex_subscription") return "Local Codex auth import";
  return "Manual paste";
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
  subscriptionAuthEnabled: boolean,
  providerIsBedrock = false
): string | null {
  if (draft.stepId === "type" && draft.mode === "claude_subscription" && !subscriptionAuthEnabled) {
    return "Enable subscription auth before creating Claude subscription credentials.";
  }
  if (draft.stepId !== "credentials") return null;
  return credentialBlockerMessage(draft, subscriptionAuthEnabled, providerIsBedrock);
}

export function credentialBlockerMessage(
  draft: CreateProviderCredentialDraft,
  subscriptionAuthEnabled: boolean,
  providerIsBedrock = false
): string | null {
  if (!draft.name.trim()) return "Enter a credential label.";
  if (providerIsBedrock) return bedrockCredentialBlockerMessage(draft);
  if (draft.mode === "claude_subscription" && !subscriptionAuthEnabled) {
    return "Claude subscription auth has been disabled for this proxy.";
  }
  if (draft.source === "openai_oauth" && draft.mode === "codex_subscription") return null;
  if (draft.source === "claude_oauth" && draft.mode === "claude_subscription") return null;
  if (draft.source === "local_auth" && draft.mode !== "api_key") return null;
  if (!draft.apiKey.trim()) return `${secretLabelForDraft(draft)} is required.`;
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

export function bedrockDiscoveryRegions(draft: CreateProviderCredentialDraft) {
  return draft.bedrockDiscoveryRegions
    .split(/[,\s]+/)
    .map((region) => region.trim())
    .filter(Boolean);
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
  const tokens = isRecord(record.tokens) ? record.tokens : undefined;
  const idToken = stringValue(record.id_token) ?? stringValue(record.idToken) ??
    stringValue(tokens?.id_token) ?? stringValue(tokens?.idToken);
  const accessToken = codexAuthJsonAccessToken(record);
  return Boolean(
    stringValue(record.chatgpt_account_id) ?? stringValue(record.chatgptAccountId) ??
      stringValue(record.account_id) ?? stringValue(record.accountId) ??
      stringValue(tokens?.account_id) ?? stringValue(tokens?.accountId) ??
      chatgptAccountIdFromJwt(idToken) ??
      chatgptAccountIdFromJwt(accessToken)
  );
}

function codexAuthJsonAccessToken(parsed: Record<string, unknown>) {
  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  return stringValue(parsed.access_token) ?? stringValue(parsed.accessToken) ??
    stringValue(tokens?.access_token) ?? stringValue(tokens?.accessToken);
}

function chatgptAccountIdFromJwt(jwt: string | undefined) {
  const claims = jwtPayload(jwt);
  if (!claims) return undefined;
  return stringValue(claims.chatgpt_account_id) ??
    stringValue(claims.chatgptAccountId) ??
    stringValue(claims.account_id) ??
    stringValue(claims.accountId) ??
    nestedAuthClaim(claims, "chatgpt_account_id") ??
    nestedAuthClaim(claims, "chatgptAccountId") ??
    nestedAuthClaim(claims, "account_id") ??
    nestedAuthClaim(claims, "accountId");
}

function jwtPayload(jwt: string | undefined) {
  if (!jwt) return undefined;
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nestedAuthClaim(claims: Record<string, unknown>, key: string) {
  const auth = claims["https://api.openai.com/auth"];
  if (!isRecord(auth)) return undefined;
  return stringValue(auth[key]);
}

function subscriptionSourceForModeChange(
  draft: CreateProviderCredentialDraft,
  mode: CreateProviderCredentialMode
) {
  if (mode === "api_key") return "manual";
  if (mode === "codex_subscription" && draft.mode === "api_key") return "openai_oauth";
  if (mode === "claude_subscription" && draft.mode === "api_key") return "claude_oauth";
  if (mode === "codex_subscription" && draft.source === "claude_oauth") return "openai_oauth";
  if (mode === "claude_subscription" && draft.source === "openai_oauth") return "claude_oauth";
  return draft.source;
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

function bedrockCredentialBlockerMessage(draft: CreateProviderCredentialDraft): string | null {
  if (!draft.bedrockRegion.trim()) return "Bedrock region is required.";
  if (bedrockDiscoveryRegions(draft).length === 0) return "Enter at least one discovery region.";
  if (draft.bedrockCredentialMode === "aws_bedrock_bearer_token" && !draft.apiKey.trim()) {
    return "Bedrock bearer token is required.";
  }
  if (draft.bedrockCredentialMode === "aws_static_keys") {
    if (!draft.bedrockAccessKeyId.trim()) return "AWS access key ID is required.";
    if (!draft.bedrockSecretAccessKey.trim()) return "AWS secret access key is required.";
  }
  return null;
}
