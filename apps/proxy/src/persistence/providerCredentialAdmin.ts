import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  apiKeyProviderAccounts,
  apiKeys,
  encryptSecret,
  providers,
  providerAccounts,
  secretHint,
  type ProxyTransaction,
  type ProxyTransactionalDatabase
} from "@proxy/db";
import {
  CLAUDE_SUBSCRIPTION_TOKEN_PREFIX,
  PROVIDER_ACCOUNT_AUTH_TYPES,
  PROVIDER_ACCOUNT_STATUSES,
  PROVIDERS
} from "@proxy/schema";

import {
  extractChatGPTAccountIdFromJwt,
  openAIChatGPTTokenBundle,
  stringifyOpenAIChatGPTTokenBundle
} from "../openAIChatGPTAuth.js";
import { createId } from "../util.js";
import { AdminMutationError } from "./adminErrors.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import type { ProviderCredentialOptions } from "./providerCredentials.js";
import { ProviderRegistryError, validateProviderBaseUrl } from "./providers.js";

const createCredentialBodySchema = z.object({
  provider: z.string().trim().min(1),
  name: z.string().trim().min(1),
  authType: z.enum(PROVIDER_ACCOUNT_AUTH_TYPES).default("api_key"),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1).optional(),
  chatgptAccountId: z.string().trim().min(1).optional(),
  oauthSource: z.enum(["setup-token", "claude-browser-oauth"]).optional()
}).strict();

const createLocalAuthCredentialBodySchema = z.object({
  provider: z.enum([PROVIDERS.OPENAI, PROVIDERS.ANTHROPIC]),
  name: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1).optional()
}).strict();

const bindApiKeyCredentialBodySchema = z.object({
  provider: z.string().trim().min(1),
  providerAccountId: z.string().trim().min(1).nullable()
}).strict();

export class ProviderCredentialAdminError extends AdminMutationError {}

export class ProviderCredentialAdminService {
  constructor(
    private readonly db: ProxyTransactionalDatabase,
    private readonly options: ProviderCredentialOptions,
    private readonly onProviderCredentialsChanged: () => void = () => {}
  ) {}

  async createCredential(input: {
    organizationId: string;
    actorUserId: string;
    body: unknown;
  }) {
    const body = createCredentialBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_provider_credential_request", body.error);
    const encryptionKey = this.options.encryptionKey;
    if (!encryptionKey) {
      throw new ProviderCredentialAdminError("provider_secret_encryption_key_missing", 503);
    }
    if (body.data.authType === "oauth" && body.data.provider === PROVIDERS.ANTHROPIC) {
      if (!this.options.subscriptionOAuthEnabled) {
        throw new ProviderCredentialAdminError("subscription_oauth_disabled", 400);
      }
    }
    const oauthCredential = body.data.authType === "oauth"
      ? parseOAuthCredential(body.data)
      : undefined;
    if (body.data.baseUrl) {
      await validateCredentialBaseUrl(body.data.baseUrl, this.options);
    }

    const providerAccountId = createId("provider_account");
    const secret = oauthCredential?.secret ?? body.data.apiKey;
    const ciphertext = encryptSecret(secret, encryptionKey);
    const hint = oauthCredential?.secretHint ?? secretHint(secret);
    const settings = oauthCredential?.settings;
    const now = new Date();

    const result = await this.db.transaction(async (tx) => {
      const provider = await providerBySlug(tx, input.organizationId, body.data.provider);
      if (!provider) throw new ProviderCredentialAdminError("provider_not_found", 404);
      const [existing] = await tx
        .select({ id: providerAccounts.id })
        .from(providerAccounts)
        .where(and(
          eq(providerAccounts.organizationId, input.organizationId),
          eq(providerAccounts.providerId, provider.id),
          eq(providerAccounts.name, body.data.name),
          eq(providerAccounts.status, PROVIDER_ACCOUNT_STATUSES.ACTIVE)
        ))
        .limit(1);
      if (existing) throw new ProviderCredentialAdminError("provider_credential_name_exists", 409);

      await tx.insert(providerAccounts).values({
        id: providerAccountId,
        organizationId: input.organizationId,
        providerId: provider.id,
        name: body.data.name,
        baseUrl: body.data.baseUrl,
        authType: body.data.authType,
        settings,
        secretCiphertext: ciphertext,
        secretHint: hint,
        createdByUserId: input.actorUserId,
        status: PROVIDER_ACCOUNT_STATUSES.ACTIVE,
        createdAt: now,
        updatedAt: now
      });
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "provider_account",
        scopeId: providerAccountId,
        correlationId: providerAccountId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.provider-accounts",
        eventType: "provider_account.created",
        payload: {
          providerAccountId,
          provider: provider.slug,
          providerId: provider.id,
          name: body.data.name,
          authType: body.data.authType,
          baseUrl: body.data.baseUrl,
          secretHint: hint
        },
        createdAt: now
      });

      return { providerAccountId };
    });
    this.onProviderCredentialsChanged();
    return result;
  }

  async createCredentialFromLocalAuth(input: {
    organizationId: string;
    actorUserId: string;
    body: unknown;
  }) {
    const body = createLocalAuthCredentialBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_provider_credential_local_auth_request", body.error);
    if (body.data.provider === PROVIDERS.ANTHROPIC && !this.options.subscriptionOAuthEnabled) {
      throw new ProviderCredentialAdminError("subscription_oauth_disabled", 400);
    }
    const localAuth = await readLocalOAuthCredential(body.data.provider);
    return this.createCredential({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      body: {
        provider: body.data.provider,
        name: body.data.name,
        authType: "oauth",
        apiKey: localAuth.apiKey,
        baseUrl: body.data.baseUrl,
        chatgptAccountId: localAuth.chatgptAccountId
      }
    });
  }

  async revokeCredential(input: {
    organizationId: string;
    actorUserId: string;
    providerAccountId: string;
  }) {
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const account = await byokAccount(tx, input.organizationId, input.providerAccountId);
      if (!account) throw new ProviderCredentialAdminError("provider_credential_not_found", 404);
      if (account.status !== PROVIDER_ACCOUNT_STATUSES.ACTIVE) throw new ProviderCredentialAdminError("provider_credential_revoked", 409);

      await tx
        .update(providerAccounts)
        .set({ status: PROVIDER_ACCOUNT_STATUSES.DISABLED, updatedAt: now })
        .where(and(
          eq(providerAccounts.organizationId, input.organizationId),
          eq(providerAccounts.id, input.providerAccountId)
        ));
      await tx
        .delete(apiKeyProviderAccounts)
        .where(and(
          eq(apiKeyProviderAccounts.organizationId, input.organizationId),
          eq(apiKeyProviderAccounts.providerAccountId, input.providerAccountId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "provider_account",
        scopeId: input.providerAccountId,
        correlationId: input.providerAccountId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.provider-accounts",
        eventType: "provider_account.revoked",
        payload: {
          providerAccountId: input.providerAccountId,
          provider: account.provider,
          name: account.name
        },
        createdAt: now
      });

      return { providerAccountId: input.providerAccountId };
    });
    this.onProviderCredentialsChanged();
    return result;
  }

  async bindApiKeyCredential(input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    apiKeyId: string;
    body: unknown;
  }) {
    const body = bindApiKeyCredentialBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_provider_credential_binding", body.error);
    const { provider, providerAccountId } = body.data;
    const now = new Date();

    const result = await this.db.transaction(async (tx) => {
      const providerRow = await providerBySlug(tx, input.organizationId, provider);
      if (!providerRow) throw new ProviderCredentialAdminError("provider_not_found", 404);
      const [apiKey] = await tx
        .select({ id: apiKeys.id, userId: apiKeys.userId })
        .from(apiKeys)
        .where(and(
          eq(apiKeys.organizationId, input.organizationId),
          eq(apiKeys.workspaceId, input.workspaceId),
          eq(apiKeys.id, input.apiKeyId)
        ))
        .limit(1);
      if (!apiKey) throw new ProviderCredentialAdminError("api_key_not_found", 404);

      if (providerAccountId === null) {
        await tx
          .delete(apiKeyProviderAccounts)
          .where(and(
            eq(apiKeyProviderAccounts.organizationId, input.organizationId),
            eq(apiKeyProviderAccounts.apiKeyId, input.apiKeyId),
            eq(apiKeyProviderAccounts.providerId, providerRow.id)
          ));
      } else {
        const account = await byokAccount(tx, input.organizationId, providerAccountId);
        if (!account) throw new ProviderCredentialAdminError("provider_credential_not_found", 404);
        if (account.status !== PROVIDER_ACCOUNT_STATUSES.ACTIVE) throw new ProviderCredentialAdminError("provider_credential_revoked", 409);
        if (account.providerId !== providerRow.id) throw new ProviderCredentialAdminError("provider_credential_provider_mismatch", 409);
        // Anti-pooling guardrail: a subscription token may only serve traffic
        // on a key owned by the engineer who pasted it. Ownerless (org-shared)
        // keys are rejected outright, not allowed through.
        if (
          account.authType === "oauth" &&
          (!apiKey.userId || apiKey.userId !== account.createdByUserId)
        ) {
          throw new ProviderCredentialAdminError("provider_credential_owner_mismatch", 409);
        }

        await tx
          .insert(apiKeyProviderAccounts)
          .values({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            apiKeyId: input.apiKeyId,
            providerId: providerRow.id,
            providerAccountId,
            createdByUserId: input.actorUserId,
            createdAt: now,
            updatedAt: now
          })
          .onConflictDoUpdate({
            target: [apiKeyProviderAccounts.organizationId, apiKeyProviderAccounts.apiKeyId, apiKeyProviderAccounts.providerId],
            set: { providerAccountId, updatedAt: now }
          });
      }

      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        scopeType: "api_key",
        scopeId: input.apiKeyId,
        correlationId: providerAccountId ?? input.apiKeyId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.api-keys",
        eventType: "provider_account.api_key_assignment_changed",
        payload: {
          apiKeyId: input.apiKeyId,
          provider: providerRow.slug,
          providerId: providerRow.id,
          providerAccountId
        },
        createdAt: now
      });

      return { apiKeyId: input.apiKeyId, provider: providerRow.slug, providerAccountId };
    });
    this.onProviderCredentialsChanged();
    return result;
  }
}

async function byokAccount(tx: ProxyTransaction, organizationId: string, providerAccountId: string) {
  const [account] = await tx
    .select({
      id: providerAccounts.id,
      providerId: providerAccounts.providerId,
      provider: providers.slug,
      name: providerAccounts.name,
      baseUrl: providerAccounts.baseUrl,
      status: providerAccounts.status,
      authType: providerAccounts.authType,
      createdByUserId: providerAccounts.createdByUserId,
      secretCiphertext: providerAccounts.secretCiphertext
    })
    .from(providerAccounts)
    .innerJoin(providers, eq(providers.id, providerAccounts.providerId))
    .where(and(
      eq(providerAccounts.organizationId, organizationId),
      eq(providerAccounts.id, providerAccountId)
    ))
    .limit(1);
  if (!account || !account.secretCiphertext) return null;
  return account;
}

type CreateCredentialBody = z.infer<typeof createCredentialBodySchema>;
type LocalOAuthProvider = typeof PROVIDERS.OPENAI | typeof PROVIDERS.ANTHROPIC;

function parseOAuthCredential(data: CreateCredentialBody) {
  if (data.provider === PROVIDERS.ANTHROPIC) {
    if (!data.apiKey.startsWith(CLAUDE_SUBSCRIPTION_TOKEN_PREFIX)) {
      throw new ProviderCredentialAdminError("invalid_subscription_token", 400, [
        {
          path: "apiKey",
          message: `Expected a \`claude setup-token\` value starting with ${CLAUDE_SUBSCRIPTION_TOKEN_PREFIX}.`
        }
      ]);
    }
    return {
      secret: data.apiKey,
      settings: { tokenKind: "claude_oauth", source: data.oauthSource ?? "setup-token" }
    };
  }

  if (data.provider !== PROVIDERS.OPENAI) {
    throw new ProviderCredentialAdminError("subscription_oauth_unsupported_provider", 400, [
      { path: "provider", message: "Subscription tokens are supported for Anthropic and OpenAI only." }
    ]);
  }

  const parsed = parseOpenAISecretInput(data.apiKey);
  const accessToken = parsed.accessToken;
  const chatgptAccountId = data.chatgptAccountId ?? parsed.chatgptAccountId;
  if (!accessToken) {
    throw new ProviderCredentialAdminError("invalid_subscription_token", 400, [
      { path: "apiKey", message: "Expected an OpenAI Codex access token." }
    ]);
  }
  if (!chatgptAccountId) {
    throw new ProviderCredentialAdminError("invalid_subscription_account_id", 400, [
      { path: "chatgptAccountId", message: "Expected a ChatGPT account ID for OpenAI subscription auth." }
    ]);
  }

  const secret = parsed.refreshToken
    ? stringifyOpenAIChatGPTTokenBundle(openAIChatGPTTokenBundle({
      accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt
    }))
    : accessToken;

  return {
    secret,
    secretHint: secretHint(accessToken),
    settings: {
      tokenKind: "openai_chatgpt",
      source: parsed.source,
      tokenStorage: parsed.refreshToken ? "token_bundle" : "access_token",
      chatgptAccountId
    }
  };
}

async function readLocalOAuthCredential(provider: LocalOAuthProvider) {
  if (provider === PROVIDERS.ANTHROPIC) {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (!token) {
      throw new ProviderCredentialAdminError("local_claude_oauth_token_missing", 400, [
        {
          path: "provider",
          message: "Run `claude setup-token`, set CLAUDE_CODE_OAUTH_TOKEN in the proxy environment, then restart the proxy."
        }
      ]);
    }
    return { apiKey: token, chatgptAccountId: undefined };
  }

  const path = localCodexAuthPath();
  let authJson: string;
  try {
    authJson = await readFile(path, "utf8");
  } catch {
    throw new ProviderCredentialAdminError("local_codex_auth_not_found", 400, [
      {
        path: "provider",
        message: `Run \`codex login\` on the proxy host, or set PROXY_CODEX_AUTH_FILE to the Codex auth JSON path. Checked ${path}.`
      }
    ]);
  }

  const parsed = parseOpenAISecretInput(authJson);
  if (!parsed.accessToken || !parsed.chatgptAccountId) {
    throw new ProviderCredentialAdminError("local_codex_auth_incomplete", 400, [
      {
        path: "provider",
        message: `Codex auth JSON at ${path} must include an access token and ChatGPT account ID.`
      }
    ]);
  }
  return { apiKey: authJson, chatgptAccountId: undefined };
}

function localCodexAuthPath() {
  const explicitPath = process.env.PROXY_CODEX_AUTH_FILE?.trim();
  if (explicitPath) return explicitPath;
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(codexHome, "auth.json");
}

function parseOpenAISecretInput(input: string) {
  const trimmed = input.trim();
  if (!trimmed.startsWith("{")) {
    return { accessToken: trimmed, chatgptAccountId: undefined, source: "codex-access-token" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ProviderCredentialAdminError("invalid_subscription_token", 400, [
      { path: "apiKey", message: "Expected a valid OpenAI Codex access token or auth JSON." }
    ]);
  }
  if (!isRecord(parsed)) {
    throw new ProviderCredentialAdminError("invalid_subscription_token", 400, [
      { path: "apiKey", message: "Expected a valid OpenAI Codex access token or auth JSON." }
    ]);
  }

  const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
  const accessToken = stringValue(parsed.access_token) ?? stringValue(parsed.accessToken) ??
    stringValue(tokens?.access_token) ?? stringValue(tokens?.accessToken);
  const idToken = stringValue(parsed.id_token) ?? stringValue(parsed.idToken) ??
    stringValue(tokens?.id_token) ?? stringValue(tokens?.idToken);
  return {
    accessToken,
    refreshToken: stringValue(parsed.refresh_token) ?? stringValue(parsed.refreshToken) ??
      stringValue(tokens?.refresh_token) ?? stringValue(tokens?.refreshToken),
    expiresAt: numberValue(parsed.expires_at) ?? numberValue(parsed.expiresAt) ??
      numberValue(tokens?.expires_at) ?? numberValue(tokens?.expiresAt),
    chatgptAccountId: stringValue(parsed.chatgpt_account_id) ?? stringValue(parsed.chatgptAccountId) ??
      stringValue(parsed.account_id) ?? stringValue(parsed.accountId) ??
      stringValue(tokens?.account_id) ?? stringValue(tokens?.accountId) ??
      extractChatGPTAccountIdFromJwt(idToken) ??
      extractChatGPTAccountIdFromJwt(accessToken),
    source: stringValue(parsed.source) === "codex-device-auth" ? "codex-device-auth" : "codex-auth-json"
  };
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

async function providerBySlug(tx: ProxyTransaction, organizationId: string, slug: string) {
  const [orgProvider] = await tx
    .select({ id: providers.id, slug: providers.slug })
    .from(providers)
    .where(and(
      eq(providers.organizationId, organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  if (orgProvider) return orgProvider;
  const [builtinProvider] = await tx
    .select({ id: providers.id, slug: providers.slug })
    .from(providers)
    .where(and(
      isNull(providers.organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  return builtinProvider;
}

function validationError(message: string, error: z.ZodError) {
  return new ProviderCredentialAdminError(
    message,
    400,
    error.issues.map((issue) => ({
      path: issue.path.join(".") || "body",
      message: issue.message
    }))
  );
}

async function validateCredentialBaseUrl(baseUrl: string, options: ProviderCredentialOptions) {
  try {
    await validateProviderBaseUrl(baseUrl, options);
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      throw new ProviderCredentialAdminError(error.code, 400, [
        { path: "baseUrl", message: error.message }
      ]);
    }
    throw error;
  }
}
