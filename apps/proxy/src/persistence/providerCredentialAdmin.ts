import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  apiKeyProviderAccounts,
  apiKeys,
  encryptSecret,
  providers,
  providerAccounts,
  secretHint,
  type PromptProxyTransaction,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";
import {
  CLAUDE_SUBSCRIPTION_TOKEN_PREFIX,
  PROVIDER_ACCOUNT_AUTH_TYPES,
  PROVIDER_ACCOUNT_STATUSES,
  PROVIDERS
} from "@prompt-proxy/schema";

import { createId } from "../util.js";
import { AdminMutationError } from "./adminErrors.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import type { ProviderCredentialOptions } from "./providerCredentials.js";

const createCredentialBodySchema = z.object({
  provider: z.string().trim().min(1),
  name: z.string().trim().min(1),
  authType: z.enum(PROVIDER_ACCOUNT_AUTH_TYPES).default("api_key"),
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1).optional(),
  chatgptAccountId: z.string().trim().min(1).optional()
}).strict();

const bindApiKeyCredentialBodySchema = z.object({
  provider: z.string().trim().min(1),
  providerAccountId: z.string().trim().min(1).nullable()
}).strict();

export class ProviderCredentialAdminError extends AdminMutationError {}

export class ProviderCredentialAdminService {
  constructor(
    private readonly db: PromptProxyTransactionalDatabase,
    private readonly options: ProviderCredentialOptions
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
    if (body.data.authType === "oauth") {
      if (!this.options.subscriptionOAuthEnabled) {
        throw new ProviderCredentialAdminError("subscription_oauth_disabled", 400);
      }
    }
    const oauthCredential = body.data.authType === "oauth"
      ? parseOAuthCredential(body.data)
      : undefined;

    const providerAccountId = createId("provider_account");
    const secret = oauthCredential?.secret ?? body.data.apiKey;
    const ciphertext = encryptSecret(secret, encryptionKey);
    const hint = secretHint(secret);
    const settings = oauthCredential?.settings;
    const now = new Date();

    return this.db.transaction(async (tx) => {
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
        producer: "prompt-proxy.admin.provider-accounts",
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
  }

  async revokeCredential(input: {
    organizationId: string;
    actorUserId: string;
    providerAccountId: string;
  }) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
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
        producer: "prompt-proxy.admin.provider-accounts",
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

    return this.db.transaction(async (tx) => {
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
        producer: "prompt-proxy.admin.api-keys",
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
  }
}

async function byokAccount(tx: PromptProxyTransaction, organizationId: string, providerAccountId: string) {
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
      settings: { tokenKind: "claude_oauth", source: "setup-token" }
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

  return {
    secret: accessToken,
    settings: {
      tokenKind: "openai_chatgpt",
      source: parsed.source,
      chatgptAccountId
    }
  };
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
  return {
    accessToken: stringValue(parsed.access_token) ?? stringValue(parsed.accessToken) ??
      stringValue(tokens?.access_token) ?? stringValue(tokens?.accessToken),
    chatgptAccountId: stringValue(parsed.chatgpt_account_id) ?? stringValue(parsed.chatgptAccountId) ??
      stringValue(parsed.account_id) ?? stringValue(parsed.accountId),
    source: "codex-auth-json"
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function providerBySlug(tx: PromptProxyTransaction, organizationId: string, slug: string) {
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
