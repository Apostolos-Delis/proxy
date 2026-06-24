import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { PROVIDERS } from "@proxy/schema";

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
const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const ANTHROPIC_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code";
const ANTHROPIC_OAUTH_ERROR_URL = "https://platform.claude.com/oauth/code/success?app=claude-code&error=prompt";
const ANTHROPIC_OAUTH_SCOPE = "user:inference";
const CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

type PendingOAuth = {
  loginId: string;
  organizationId: string;
  actorUserId: string;
  status: "pending" | "completed" | "failed";
  providerAccountId?: string;
  error?: string;
  expiresAt: number;
  cancel?: () => void;
  cancelMessage: string;
};

type AnthropicOAuthCallbackResult = {
  authorizationCode: string;
  complete: (success: boolean) => void;
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
  }) {
    this.pruneExpired();
    const deviceCode = await this.requestDeviceCode();
    const loginId = createId("provider_oauth");
    const pending: PendingOAuth = {
      loginId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      status: "pending",
      expiresAt: Date.now() + DEVICE_CODE_TIMEOUT_MS,
      cancelMessage: "OpenAI sign-in cancelled."
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

  async startAnthropicClaudeCodeAuth(input: {
    organizationId: string;
    actorUserId: string;
    name: string;
  }) {
    this.pruneExpired();
    const codeVerifier = oauthSecret();
    const codeChallenge = oauthCodeChallenge(codeVerifier);
    const state = oauthSecret();
    const callback = await startAnthropicOAuthCallback(state);
    const loginId = createId("provider_oauth");
    const pending: PendingOAuth = {
      loginId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      status: "pending",
      expiresAt: Date.now() + DEVICE_CODE_TIMEOUT_MS,
      cancel: callback.close,
      cancelMessage: "Claude sign-in cancelled."
    };
    this.pending.set(loginId, pending);

    void this.completeAnthropicClaudeCodeAuth({
      ...input,
      loginId,
      codeVerifier,
      state,
      port: callback.port,
      callbackResult: callback.result,
      closeCallback: callback.close
    });

    return {
      loginId,
      verificationUrl: anthropicAuthUrl({
        codeChallenge,
        state,
        port: callback.port
      }),
      userCode: null
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

  cancel(loginId: string, scope: OAuthStatusScope): ProviderCredentialOAuthStatus | null {
    this.pruneExpired();
    const pending = this.pending.get(loginId);
    if (!pending) return null;
    if (
      pending.organizationId !== scope.organizationId ||
      pending.actorUserId !== scope.actorUserId
    ) {
      return null;
    }
    if (pending.status === "pending") {
      pending.cancel?.();
      this.pending.set(loginId, {
        ...pending,
        status: "failed",
        error: pending.cancelMessage
      });
    }
    return this.status(loginId, scope);
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
    loginId: string;
    deviceAuthId: string;
    userCode: string;
    intervalMs: number;
  }) {
    try {
      const code = await this.pollDeviceCode(input);
      if (!this.isPending(input.loginId)) return;
      const tokens = await this.exchangeCode(code.authorizationCode, code.codeVerifier);
      if (!this.isPending(input.loginId)) return;
      const chatgptAccountId =
        extractChatGPTAccountIdFromJwt(tokens.id_token) ??
        extractChatGPTAccountIdFromJwt(tokens.access_token);
      if (!tokens.refresh_token) throw new Error("openai_codex_login_missing_refresh_token");
      if (!chatgptAccountId) throw new Error("openai_codex_login_missing_chatgpt_account_id");
      if (!this.isPending(input.loginId)) return;
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
      if (!this.isPending(input.loginId)) throw new Error("openai_codex_device_code_cancelled");
      const response = await this.fetcher(`${OPENAI_AUTH_ISSUER}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: input.deviceAuthId,
          user_code: input.userCode
        })
      });
      if (!this.isPending(input.loginId)) throw new Error("openai_codex_device_code_cancelled");

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

  private async completeAnthropicClaudeCodeAuth(input: {
    organizationId: string;
    actorUserId: string;
    name: string;
    loginId: string;
    codeVerifier: string;
    state: string;
    port: number;
    callbackResult: Promise<AnthropicOAuthCallbackResult>;
    closeCallback: () => void;
  }) {
    let callback: AnthropicOAuthCallbackResult | undefined;
    try {
      callback = await withTimeout(
        input.callbackResult,
        DEVICE_CODE_TIMEOUT_MS,
        "anthropic_claude_code_login_timeout"
      );
      if (!this.isPending(input.loginId)) {
        callback.complete(false);
        return;
      }
      const tokens = await this.exchangeAnthropicCode({
        authorizationCode: callback.authorizationCode,
        codeVerifier: input.codeVerifier,
        state: input.state,
        port: input.port
      });
      if (!this.isPending(input.loginId)) {
        callback.complete(false);
        return;
      }
      const created = await this.providerCredentialAdmin.createCredential({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        body: {
          provider: PROVIDERS.ANTHROPIC,
          name: input.name,
          authType: "oauth",
          apiKey: tokens.accessToken,
          oauthSource: "claude-browser-oauth"
        }
      });
      callback.complete(true);
      this.complete(input.loginId, created.providerAccountId);
    } catch (error) {
      callback?.complete(false);
      this.fail(input.loginId, error);
    } finally {
      input.closeCallback();
    }
  }

  private async exchangeAnthropicCode(input: {
    authorizationCode: string;
    codeVerifier: string;
    state: string;
    port: number;
  }) {
    const response = await this.fetcher(ANTHROPIC_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: input.authorizationCode,
        redirect_uri: `http://localhost:${input.port}/callback`,
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        code_verifier: input.codeVerifier,
        state: input.state,
        expires_in: CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS
      })
    });
    if (!response.ok) throw new Error(`anthropic_claude_code_token_exchange_failed:${response.status}`);
    const body = await response.json() as { access_token?: string };
    const accessToken = body.access_token?.trim();
    if (!accessToken) throw new Error("anthropic_claude_code_token_exchange_missing_access_token");
    return { accessToken };
  }

  private complete(loginId: string, providerAccountId: string) {
    const pending = this.pending.get(loginId);
    if (!pending || pending.status !== "pending") return;
    this.pending.set(loginId, {
      ...pending,
      status: "completed",
      providerAccountId,
      error: undefined
    });
  }

  private fail(loginId: string, error: unknown) {
    const pending = this.pending.get(loginId);
    if (!pending || pending.status !== "pending") return;
    this.pending.set(loginId, {
      ...pending,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  private pruneExpired(now = Date.now()) {
    for (const [loginId, pending] of this.pending) {
      if (pending.expiresAt + OAUTH_STATUS_RETENTION_MS < now) {
        pending.cancel?.();
        this.pending.delete(loginId);
      }
    }
  }

  private isPending(loginId: string) {
    return this.pending.get(loginId)?.status === "pending";
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oauthSecret() {
  return randomBytes(32).toString("base64url");
}

function oauthCodeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function anthropicAuthUrl(input: { codeChallenge: string; state: string; port: number }) {
  const url = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `http://localhost:${input.port}/callback`);
  url.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function startAnthropicOAuthCallback(expectedState: string) {
  let settled = false;
  let closed = false;
  let pendingResponse: ServerResponse | null = null;
  let resolveResult: (result: AnthropicOAuthCallbackResult) => void = () => {};
  let rejectResult: (error: Error) => void = () => {};
  const result = new Promise<AnthropicOAuthCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const rejectOnce = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectResult(error);
  };
  const server = createServer((request, response) => {
    const parsedUrl = new URL(request.url ?? "", `http://${request.headers.host ?? "localhost"}`);
    if (parsedUrl.pathname !== "/callback") {
      response.writeHead(404);
      response.end();
      return;
    }
    const authorizationCode = parsedUrl.searchParams.get("code")?.trim();
    const state = parsedUrl.searchParams.get("state")?.trim();
    if (!authorizationCode) {
      response.writeHead(400);
      response.end("Authorization code not found");
      rejectOnce(new Error("anthropic_claude_code_login_missing_code"));
      return;
    }
    if (state !== expectedState) {
      response.writeHead(400);
      response.end("Invalid state parameter");
      rejectOnce(new Error("anthropic_claude_code_login_invalid_state"));
      return;
    }
    if (settled) {
      response.writeHead(409);
      response.end("OAuth callback already received");
      return;
    }
    pendingResponse = response;
    settled = true;
    resolveResult({
      authorizationCode,
      complete: (success) => {
        if (!pendingResponse) return;
        pendingResponse.writeHead(302, { Location: success ? ANTHROPIC_OAUTH_SUCCESS_URL : ANTHROPIC_OAUTH_ERROR_URL });
        pendingResponse.end();
        pendingResponse = null;
      }
    });
  });

  server.on("error", (error) => rejectOnce(error));
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

  const close = () => {
    if (closed) return;
    closed = true;
    if (pendingResponse) {
      pendingResponse.writeHead(302, { Location: ANTHROPIC_OAUTH_ERROR_URL });
      pendingResponse.end();
      pendingResponse = null;
    }
    server.close();
    rejectOnce(new Error("anthropic_claude_code_login_cancelled"));
  };

  return { port, result, close };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([
    promise.finally(() => {
      if (timeout) clearTimeout(timeout);
    }),
    timeoutPromise
  ]);
}
