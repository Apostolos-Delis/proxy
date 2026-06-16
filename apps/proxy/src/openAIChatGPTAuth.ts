export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
export const OPENAI_CHATGPT_TOKEN_BUNDLE_KIND = "openai_chatgpt_token_bundle";

export type OpenAIChatGPTTokenBundle = {
  kind: typeof OPENAI_CHATGPT_TOKEN_BUNDLE_KIND;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export type OpenAIChatGPTSecret =
  | { kind: "access_token"; accessToken: string }
  | { kind: "token_bundle"; bundle: OpenAIChatGPTTokenBundle };

export type OpenAIChatGPTTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
};

export function openAIChatGPTTokenBundle(input: {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  now?: number;
}): OpenAIChatGPTTokenBundle {
  return {
    kind: OPENAI_CHATGPT_TOKEN_BUNDLE_KIND,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt ?? (input.now ?? Date.now()) + 60 * 60 * 1000
  };
}

export function stringifyOpenAIChatGPTTokenBundle(bundle: OpenAIChatGPTTokenBundle) {
  return JSON.stringify(bundle);
}

export function parseOpenAIChatGPTSecret(secret: string): OpenAIChatGPTSecret {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return { kind: "access_token", accessToken: trimmed };

  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed) && parsed.kind === OPENAI_CHATGPT_TOKEN_BUNDLE_KIND) {
      const accessToken = stringValue(parsed.accessToken);
      const refreshToken = stringValue(parsed.refreshToken);
      const expiresAt = numberValue(parsed.expiresAt);
      if (accessToken && refreshToken && expiresAt) {
        return {
          kind: "token_bundle",
          bundle: {
            kind: OPENAI_CHATGPT_TOKEN_BUNDLE_KIND,
            accessToken,
            refreshToken,
            expiresAt
          }
        };
      }
    }
  } catch {
    return { kind: "access_token", accessToken: trimmed };
  }

  return { kind: "access_token", accessToken: trimmed };
}

export async function refreshOpenAIChatGPTTokenBundle(input: {
  bundle: OpenAIChatGPTTokenBundle;
  now?: number;
  fetcher?: typeof fetch;
}) {
  const now = input.now ?? Date.now();
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(`${OPENAI_AUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.bundle.refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID
    }).toString()
  });
  if (!response.ok) {
    throw new Error(`openai_chatgpt_token_refresh_failed:${response.status}`);
  }
  const tokens = await response.json() as OpenAIChatGPTTokenResponse;
  if (!tokens.access_token) throw new Error("openai_chatgpt_token_refresh_missing_access_token");
  return openAIChatGPTTokenBundle({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? input.bundle.refreshToken,
    expiresAt: now + (tokens.expires_in ?? 3600) * 1000
  });
}

export function extractChatGPTAccountIdFromJwt(jwt: string | undefined) {
  if (!jwt) return undefined;
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

export function extractChatGPTPlanTypeFromJwt(jwt: string | undefined) {
  if (!jwt) return undefined;
  const claims = jwtPayload(jwt);
  if (!claims) return undefined;
  return stringValue(claims.chatgpt_plan_type) ??
    stringValue(claims.chatgptPlanType) ??
    nestedAuthClaim(claims, "chatgpt_plan_type") ??
    nestedAuthClaim(claims, "chatgptPlanType");
}

function jwtPayload(jwt: string) {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
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

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
