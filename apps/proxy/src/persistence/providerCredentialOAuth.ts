import { PROVIDERS } from "@prompt-proxy/schema";

import {
  extractChatGPTAccountIdFromJwt,
  OPENAI_AUTH_ISSUER,
  OPENAI_CODEX_CLIENT_ID,
  type OpenAIChatGPTTokenResponse
} from "../openAIChatGPTAuth.js";
import { createId } from "../util.js";
import type { ProviderCredentialAdminService } from "./providerCredentialAdmin.js";

const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const OAUTH_STATUS_RETENTION_MS = 15 * 60 * 1000;

type PendingOAuth = {
  loginId: string;
  organizationId: string;
  actorUserId: string;
  status: "pending" | "completed" | "failed";
  providerAccountId?: string;
  error?: string;
  expiresAt: number;
};

type OAuthStatusScope = {
  organizationId: string;
  actorUserId: string;
};

export type ProviderCredentialOAuthStatus = Pick<
  PendingOAuth,
  "loginId" | "status" | "providerAccountId" | "error"
>;

export class ProviderCredentialOAuthService {
  private readonly pending = new Map<string, PendingOAuth>();

  constructor(
    private readonly providerCredentialAdmin: ProviderCredentialAdminService,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async startOpenAICodexDeviceAuth(input: {
    organizationId: string;
    actorUserId: string;
    name: string;
    baseUrl?: string;
  }) {
    this.pruneExpired();
    const deviceCode = await this.requestDeviceCode();
    const loginId = createId("provider_oauth");
    const pending: PendingOAuth = {
      loginId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      status: "pending",
      expiresAt: Date.now() + DEVICE_CODE_TIMEOUT_MS
    };
    this.pending.set(loginId, pending);

    void this.completeOpenAICodexDeviceAuth({
      ...input,
      loginId,
      deviceAuthId: deviceCode.deviceAuthId,
      userCode: deviceCode.userCode,
      intervalMs: deviceCode.intervalMs
    });

    return {
      loginId,
      verificationUrl: `${OPENAI_AUTH_ISSUER}/codex/device`,
      userCode: deviceCode.userCode
    };
  }

  status(loginId: string, scope?: OAuthStatusScope): ProviderCredentialOAuthStatus | null {
    this.pruneExpired();
    const pending = this.pending.get(loginId);
    if (!pending) return null;
    if (scope && (
      pending.organizationId !== scope.organizationId ||
      pending.actorUserId !== scope.actorUserId
    )) {
      return null;
    }
    return {
      loginId: pending.loginId,
      status: pending.status,
      providerAccountId: pending.providerAccountId,
      error: pending.error
    };
  }

  private async requestDeviceCode() {
    const response = await this.fetcher(`${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID })
    });
    if (!response.ok) throw new Error(`openai_codex_device_code_failed:${response.status}`);
    const body = await response.json() as {
      device_auth_id?: string;
      user_code?: string;
      usercode?: string;
      interval?: string;
    };
    const deviceAuthId = body.device_auth_id?.trim();
    const userCode = (body.user_code ?? body.usercode)?.trim();
    if (!deviceAuthId || !userCode) throw new Error("openai_codex_device_code_incomplete");
    const intervalMs = Math.max(Number.parseInt(body.interval ?? "5", 10) || 5, 1) * 1000;
    return { deviceAuthId, userCode, intervalMs };
  }

  private async completeOpenAICodexDeviceAuth(input: {
    organizationId: string;
    actorUserId: string;
    name: string;
    baseUrl?: string;
    loginId: string;
    deviceAuthId: string;
    userCode: string;
    intervalMs: number;
  }) {
    try {
      const code = await this.pollDeviceCode(input);
      const tokens = await this.exchangeCode(code.authorizationCode, code.codeVerifier);
      const chatgptAccountId =
        extractChatGPTAccountIdFromJwt(tokens.id_token) ??
        extractChatGPTAccountIdFromJwt(tokens.access_token);
      if (!tokens.refresh_token) throw new Error("openai_codex_login_missing_refresh_token");
      if (!chatgptAccountId) throw new Error("openai_codex_login_missing_chatgpt_account_id");
      const created = await this.providerCredentialAdmin.createCredential({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        body: {
          provider: PROVIDERS.OPENAI,
          name: input.name,
          authType: "oauth",
          apiKey: JSON.stringify({
            source: "codex-device-auth",
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
            id_token: tokens.id_token,
            chatgpt_account_id: chatgptAccountId
          }),
          baseUrl: input.baseUrl,
          chatgptAccountId
        }
      });
      this.complete(input.loginId, created.providerAccountId);
    } catch (error) {
      this.fail(input.loginId, error);
    }
  }

  private async pollDeviceCode(input: {
    loginId: string;
    deviceAuthId: string;
    userCode: string;
    intervalMs: number;
  }) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < DEVICE_CODE_TIMEOUT_MS) {
      const response = await this.fetcher(`${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: input.deviceAuthId,
          user_code: input.userCode
        })
      });

      if (response.ok) {
        const body = await response.json() as {
          authorization_code?: string;
          code_verifier?: string;
        };
        const authorizationCode = body.authorization_code?.trim();
        const codeVerifier = body.code_verifier?.trim();
        if (!authorizationCode || !codeVerifier) throw new Error("openai_codex_device_token_incomplete");
        return { authorizationCode, codeVerifier };
      }

      if (response.status !== 403 && response.status !== 404) {
        throw new Error(`openai_codex_device_token_failed:${response.status}`);
      }

      await sleep(input.intervalMs);
    }
    throw new Error("openai_codex_device_code_timeout");
  }

  private async exchangeCode(authorizationCode: string, codeVerifier: string) {
    const response = await this.fetcher(`${OPENAI_AUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: `${OPENAI_AUTH_ISSUER}/deviceauth/callback`,
        client_id: OPENAI_CODEX_CLIENT_ID,
        code_verifier: codeVerifier
      }).toString()
    });
    if (!response.ok) throw new Error(`openai_codex_token_exchange_failed:${response.status}`);
    const tokens = await response.json() as OpenAIChatGPTTokenResponse;
    if (!tokens.access_token) throw new Error("openai_codex_token_exchange_missing_access_token");
    return tokens;
  }

  private complete(loginId: string, providerAccountId: string) {
    const pending = this.pending.get(loginId);
    if (!pending) return;
    this.pending.set(loginId, {
      ...pending,
      status: "completed",
      providerAccountId,
      error: undefined
    });
  }

  private fail(loginId: string, error: unknown) {
    const pending = this.pending.get(loginId);
    if (!pending) return;
    this.pending.set(loginId, {
      ...pending,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  private pruneExpired(now = Date.now()) {
    for (const [loginId, pending] of this.pending) {
      if (pending.expiresAt + OAUTH_STATUS_RETENTION_MS < now) {
        this.pending.delete(loginId);
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
