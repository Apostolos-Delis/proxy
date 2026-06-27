import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { and, eq, isNull, ne } from "drizzle-orm";
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
  PROVIDERS,
  type ProviderAccountAuthType
} from "@proxy/schema";

import {
  extractChatGPTAccountIdFromJwt,
  openAIChatGPTTokenBundle,
  stringifyOpenAIChatGPTTokenBundle
} from "../openAIChatGPTAuth.js";
import {
  BEDROCK_CREDENTIAL_MODES,
  type BedrockCredentialMode
} from "../providerAdapters/bedrockCredentials.js";
import { createId } from "../util.js";
import { AdminMutationError } from "./adminErrors.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import type { ProviderCredentialOptions } from "./providerCredentials.js";
import { ProviderRegistryError, validateProviderBaseUrl } from "./providers.js";

const createCredentialBodySchema = z.object({
  provider: z.string().trim().min(1),
  name: z.string().trim().min(1),
  authType: z.enum(PROVIDER_ACCOUNT_AUTH_TYPES).default("api_key"),
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  credentialMode: z.enum(BEDROCK_CREDENTIAL_MODES).optional(),
  region: z.string().trim().min(1).optional(),
  endpointOverride: z.string().trim().min(1).optional(),
  discoveryRegions: z.array(z.string().trim().min(1)).optional(),
  accessKeyId: z.string().trim().min(1).optional(),
  secretAccessKey: z.string().trim().min(1).optional(),
  sessionToken: z.string().trim().min(1).optional(),
  chatgptAccountId: z.string().trim().min(1).optional(),
  oauthSource: z.enum(["setup-token", "claude-browser-oauth"]).optional()
}).strict();

const updateCredentialBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
  baseUrl: z.string().trim().min(1).nullable().optional(),
  credentialMode: z.enum(BEDROCK_CREDENTIAL_MODES).optional(),
  region: z.string().trim().min(1).optional(),
  endpointOverride: z.string().trim().min(1).nullable().optional(),
  discoveryRegions: z.array(z.string().trim().min(1)).optional(),
  accessKeyId: z.string().trim().min(1).optional(),
  secretAccessKey: z.string().trim().min(1).optional(),
  sessionToken: z.string().trim().min(1).optional()
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

type ProviderLookup = {
  id: string;
  slug: string;
  organizationId: string | null;
  adapterKind: string;
  authStyle: string;
};

type PreparedProviderCredential = {
  authType: ProviderAccountAuthType;
  baseUrl?: string;
  settings?: Record<string, unknown>;
  secretCiphertext?: string;
  secretHint?: string | null;
};

type PreparedProviderCredentialUpdate = {
  baseUrl: string | null;
  settings: Record<string, unknown>;
  secretCiphertext?: string | null;
  secretHint?: string | null;
  secretUpdated: boolean;
};

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
    if (body.data.baseUrl) {
      await validateCredentialBaseUrl(body.data.baseUrl, this.options);
    }
    if (body.data.endpointOverride && body.data.endpointOverride !== body.data.baseUrl) {
      await validateCredentialBaseUrl(body.data.endpointOverride, this.options, "endpointOverride");
    }
    const providerAccountId = createId("provider_account");
    const now = new Date();

    const result = await this.db.transaction(async (tx) => {
      const provider = await providerBySlug(tx, input.organizationId, body.data.provider);
      if (!provider) throw new ProviderCredentialAdminError("provider_not_found", 404);
      const credential = await prepareProviderCredential({
        body: body.data,
        provider,
        options: this.options
      });
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
        baseUrl: credential.baseUrl,
        authType: credential.authType,
        settings: credential.settings,
        secretCiphertext: credential.secretCiphertext,
        secretHint: credential.secretHint,
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
          authType: credential.authType,
          baseUrl: credential.baseUrl,
          credentialMode: credential.settings?.credentialMode,
          region: credential.settings?.region,
          discoveryRegions: credential.settings?.discoveryRegions,
          endpointOverride: credential.settings?.endpointOverride,
          secretHint: credential.secretHint
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

  async updateCredential(input: {
    organizationId: string;
    actorUserId: string;
    providerAccountId: string;
    body: unknown;
  }) {
    const body = updateCredentialBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_provider_credential_request", body.error);
    if (body.data.baseUrl) {
      await validateCredentialBaseUrl(body.data.baseUrl, this.options);
    }
    if (body.data.endpointOverride && body.data.endpointOverride !== body.data.baseUrl) {
      await validateCredentialBaseUrl(body.data.endpointOverride, this.options, "endpointOverride");
    }
    const now = new Date();

    const result = await this.db.transaction(async (tx) => {
      const account = await byokAccount(tx, input.organizationId, input.providerAccountId);
      if (!account) throw new ProviderCredentialAdminError("provider_credential_not_found", 404);
      if (account.status !== PROVIDER_ACCOUNT_STATUSES.ACTIVE) throw new ProviderCredentialAdminError("provider_credential_revoked", 409);
      if (account.providerAdapterKind !== "aws-bedrock-converse") {
        rejectBedrockUpdateFields(body.data);
        throw new ProviderCredentialAdminError("provider_credential_update_unsupported", 400);
      }

      const update = await prepareBedrockProviderCredentialUpdate({
        body: body.data,
        account,
        options: this.options
      });
      const nextName = body.data.name ?? account.name;
      if (nextName !== account.name) {
        const [existing] = await tx
          .select({ id: providerAccounts.id })
          .from(providerAccounts)
          .where(and(
            eq(providerAccounts.organizationId, input.organizationId),
            eq(providerAccounts.providerId, account.providerId),
            eq(providerAccounts.name, nextName),
            eq(providerAccounts.status, PROVIDER_ACCOUNT_STATUSES.ACTIVE),
            ne(providerAccounts.id, input.providerAccountId)
          ))
          .limit(1);
        if (existing) throw new ProviderCredentialAdminError("provider_credential_name_exists", 409);
      }

      await tx
        .update(providerAccounts)
        .set({
          name: nextName,
          baseUrl: update.baseUrl,
          settings: update.settings,
          ...(update.secretUpdated ? {
            secretCiphertext: update.secretCiphertext,
            secretHint: update.secretHint
          } : {}),
          updatedAt: now
        })
        .where(and(
          eq(providerAccounts.organizationId, input.organizationId),
          eq(providerAccounts.id, input.providerAccountId)
        ));

      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "provider_account",
        scopeId: input.providerAccountId,
        correlationId: input.providerAccountId,
        actorUserId: input.actorUserId,
        producer: "proxy.admin.provider-accounts",
        eventType: "provider_account.updated",
        payload: {
          providerAccountId: input.providerAccountId,
          provider: account.provider,
          providerId: account.providerId,
          name: nextName,
          credentialMode: update.settings.credentialMode,
          region: update.settings.region,
          discoveryRegions: update.settings.discoveryRegions,
          endpointOverride: update.settings.endpointOverride,
          secretHint: update.secretUpdated ? update.secretHint : account.secretHint,
          secretUpdated: update.secretUpdated
        },
        createdAt: now
      });

      return { providerAccountId: input.providerAccountId };
    });
    this.onProviderCredentialsChanged();
    return result;
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
      providerOrganizationId: providers.organizationId,
      name: providerAccounts.name,
      baseUrl: providerAccounts.baseUrl,
      status: providerAccounts.status,
      authType: providerAccounts.authType,
      createdByUserId: providerAccounts.createdByUserId,
      secretCiphertext: providerAccounts.secretCiphertext,
      secretHint: providerAccounts.secretHint,
      settings: providerAccounts.settings,
      providerAdapterKind: providers.adapterKind
    })
    .from(providerAccounts)
    .innerJoin(providers, eq(providers.id, providerAccounts.providerId))
    .where(and(
      eq(providerAccounts.organizationId, organizationId),
      eq(providerAccounts.id, providerAccountId)
    ))
    .limit(1);
  if (!account || !hasProviderAccountCredential(account)) return null;
  return account;
}

type CreateCredentialBody = z.infer<typeof createCredentialBodySchema>;
type UpdateCredentialBody = z.infer<typeof updateCredentialBodySchema>;
type SecretBackedCreateCredentialBody = CreateCredentialBody & { apiKey: string };
type PreparedAccountCheck = {
  secretCiphertext: string | null;
  settings: Record<string, unknown>;
  providerAdapterKind: string;
};
type BedrockProviderAccountForUpdate = NonNullable<Awaited<ReturnType<typeof byokAccount>>>;
type LocalOAuthProvider = typeof PROVIDERS.OPENAI | typeof PROVIDERS.ANTHROPIC;

async function prepareProviderCredential(input: {
  body: CreateCredentialBody;
  provider: ProviderLookup;
  options: ProviderCredentialOptions;
}): Promise<PreparedProviderCredential> {
  if (input.provider.adapterKind === "aws-bedrock-converse") {
    return prepareBedrockProviderCredential(input);
  }
  return prepareHttpProviderCredential(input);
}

async function prepareHttpProviderCredential(input: {
  body: CreateCredentialBody;
  provider: ProviderLookup;
  options: ProviderCredentialOptions;
}): Promise<PreparedProviderCredential> {
  rejectBedrockFields(input.body);
  const encryptionKey = input.options.encryptionKey;
  if (!encryptionKey) {
    throw new ProviderCredentialAdminError("provider_secret_encryption_key_missing", 503);
  }
  const apiKey = requiredBodyString(input.body.apiKey, "apiKey");
  if (input.body.authType === "oauth" && input.body.provider === PROVIDERS.ANTHROPIC) {
    if (!input.options.subscriptionOAuthEnabled) {
      throw new ProviderCredentialAdminError("subscription_oauth_disabled", 400);
    }
  }
  const oauthCredential = input.body.authType === "oauth"
    ? parseOAuthCredential({ ...input.body, apiKey })
    : undefined;
  const secret = oauthCredential?.secret ?? apiKey;
  return {
    authType: input.body.authType,
    baseUrl: input.body.baseUrl,
    settings: oauthCredential?.settings,
    secretCiphertext: encryptSecret(secret, encryptionKey),
    secretHint: oauthCredential?.secretHint ?? secretHint(secret)
  };
}

async function prepareBedrockProviderCredential(input: {
  body: CreateCredentialBody;
  provider: ProviderLookup;
  options: ProviderCredentialOptions;
}): Promise<PreparedProviderCredential> {
  if (input.body.authType !== "api_key") {
    throw fieldError("invalid_bedrock_provider_credential", "authType", "Bedrock provider accounts use AWS credential modes, not OAuth.");
  }
  const credentialMode = requiredCredentialMode(input.body.credentialMode);
  const region = requiredRegion(input.body.region, "region");
  const discoveryRegions = uniqueRegions(input.body.discoveryRegions ?? [region], "discoveryRegions");
  const endpointOverride = input.body.endpointOverride ?? input.body.baseUrl;
  if (input.body.endpointOverride && input.body.baseUrl && input.body.endpointOverride !== input.body.baseUrl) {
    throw fieldError("invalid_bedrock_provider_credential", "endpointOverride", "Use either endpointOverride or baseUrl for a Bedrock endpoint override, not both.");
  }
  if ((credentialMode === "aws_default_chain" || credentialMode === "aws_profile") && input.provider.organizationId !== null) {
    throw fieldError("invalid_bedrock_provider_credential", "credentialMode", "Org-defined Bedrock providers cannot use operator AWS credentials.");
  }

  const settings = {
    credentialMode,
    region,
    discoveryRegions,
    ...(endpointOverride ? { endpointOverride } : {})
  };
  if (credentialMode === "aws_default_chain" || credentialMode === "aws_profile") {
    rejectSecretFieldsForCredentialMode(input.body, credentialMode);
    return {
      authType: "api_key",
      baseUrl: endpointOverride,
      settings,
      secretHint: null
    };
  }

  const encryptionKey = input.options.encryptionKey;
  if (!encryptionKey) {
    throw new ProviderCredentialAdminError("provider_secret_encryption_key_missing", 503);
  }
  if (credentialMode === "aws_bedrock_bearer_token") {
    const bearerToken = requiredBodyString(input.body.apiKey, "apiKey");
    rejectStaticKeyFieldsForBearer(input.body);
    return {
      authType: "api_key",
      baseUrl: endpointOverride,
      settings,
      secretCiphertext: encryptSecret(bearerToken, encryptionKey),
      secretHint: secretHint(bearerToken)
    };
  }

  const accessKeyId = requiredBodyString(input.body.accessKeyId, "accessKeyId");
  const secretAccessKey = requiredBodyString(input.body.secretAccessKey, "secretAccessKey");
  const staticSecret = input.body.sessionToken
    ? { accessKeyId, secretAccessKey, sessionToken: input.body.sessionToken }
    : { accessKeyId, secretAccessKey };
  if (input.body.apiKey) {
    throw fieldError("invalid_bedrock_provider_credential", "apiKey", "Static Bedrock credentials use accessKeyId and secretAccessKey, not apiKey.");
  }
  return {
    authType: "api_key",
    baseUrl: endpointOverride,
    settings,
    secretCiphertext: encryptSecret(JSON.stringify(staticSecret), encryptionKey),
    secretHint: secretHint(accessKeyId)
  };
}

async function prepareBedrockProviderCredentialUpdate(input: {
  body: UpdateCredentialBody;
  account: BedrockProviderAccountForUpdate;
  options: ProviderCredentialOptions;
}): Promise<PreparedProviderCredentialUpdate> {
  const existing = bedrockCredentialSettings(input.account.settings);
  const credentialMode = requiredCredentialMode(input.body.credentialMode ?? existing.credentialMode);
  const region = requiredRegion(input.body.region ?? existing.region, "region");
  const discoveryRegions = uniqueRegions(input.body.discoveryRegions ?? existing.discoveryRegions ?? [region], "discoveryRegions");
  const endpointOverride = bedrockEndpointOverride(input.body, existing.endpointOverride);
  if (input.body.endpointOverride && input.body.baseUrl && input.body.endpointOverride !== input.body.baseUrl) {
    throw fieldError("invalid_bedrock_provider_credential", "endpointOverride", "Use either endpointOverride or baseUrl for a Bedrock endpoint override, not both.");
  }
  if ((credentialMode === "aws_default_chain" || credentialMode === "aws_profile") && input.account.providerOrganizationId !== null) {
    throw fieldError("invalid_bedrock_provider_credential", "credentialMode", "Org-defined Bedrock providers cannot use operator AWS credentials.");
  }

  const settings = {
    credentialMode,
    region,
    discoveryRegions,
    ...(endpointOverride ? { endpointOverride } : {})
  };
  if (credentialMode === "aws_default_chain" || credentialMode === "aws_profile") {
    rejectSecretFieldsForCredentialMode(input.body, credentialMode);
    return {
      baseUrl: endpointOverride ?? null,
      settings,
      secretCiphertext: null,
      secretHint: null,
      secretUpdated: input.account.secretCiphertext !== null || input.account.secretHint !== null
    };
  }

  if (credentialMode === "aws_bedrock_bearer_token") {
    rejectStaticKeyFieldsForBearer(input.body);
    if (input.body.apiKey) {
      const encryptionKey = requiredEncryptionKey(input.options);
      return {
        baseUrl: endpointOverride ?? null,
        settings,
        secretCiphertext: encryptSecret(input.body.apiKey, encryptionKey),
        secretHint: secretHint(input.body.apiKey),
        secretUpdated: true
      };
    }
    if (existing.credentialMode === "aws_bedrock_bearer_token" && input.account.secretCiphertext) {
      return {
        baseUrl: endpointOverride ?? null,
        settings,
        secretUpdated: false
      };
    }
    throw fieldError("invalid_provider_credential_request", "apiKey", "Required");
  }

  if (input.body.apiKey) {
    throw fieldError("invalid_bedrock_provider_credential", "apiKey", "Static Bedrock credentials use accessKeyId and secretAccessKey, not apiKey.");
  }
  if (hasStaticKeyUpdate(input.body)) {
    const encryptionKey = requiredEncryptionKey(input.options);
    const accessKeyId = requiredBodyString(input.body.accessKeyId, "accessKeyId");
    const secretAccessKey = requiredBodyString(input.body.secretAccessKey, "secretAccessKey");
    const staticSecret = input.body.sessionToken
      ? { accessKeyId, secretAccessKey, sessionToken: input.body.sessionToken }
      : { accessKeyId, secretAccessKey };
    return {
      baseUrl: endpointOverride ?? null,
      settings,
      secretCiphertext: encryptSecret(JSON.stringify(staticSecret), encryptionKey),
      secretHint: secretHint(accessKeyId),
      secretUpdated: true
    };
  }
  if (existing.credentialMode === "aws_static_keys" && input.account.secretCiphertext) {
    return {
      baseUrl: endpointOverride ?? null,
      settings,
      secretUpdated: false
    };
  }
  throw fieldError("invalid_provider_credential_request", "accessKeyId", "Required");
}

function hasProviderAccountCredential(account: PreparedAccountCheck) {
  if (account.secretCiphertext) return true;
  if (account.providerAdapterKind !== "aws-bedrock-converse") return false;
  const mode = account.settings.credentialMode;
  return mode === "aws_default_chain" || mode === "aws_profile";
}

function rejectBedrockFields(body: CreateCredentialBody) {
  const fields = [
    "credentialMode",
    "region",
    "endpointOverride",
    "discoveryRegions",
    "accessKeyId",
    "secretAccessKey",
    "sessionToken"
  ] as const;
  const issues = fields
    .filter((field) => body[field] !== undefined)
    .map((field) => ({
      path: field,
      message: "Bedrock credential fields are only valid for aws-bedrock-converse providers."
    }));
  if (issues.length > 0) {
    throw new ProviderCredentialAdminError("invalid_provider_credential_request", 400, issues);
  }
}

function rejectBedrockUpdateFields(body: UpdateCredentialBody) {
  const fields = [
    "credentialMode",
    "region",
    "endpointOverride",
    "discoveryRegions",
    "accessKeyId",
    "secretAccessKey",
    "sessionToken"
  ] as const;
  const issues = fields
    .filter((field) => body[field] !== undefined)
    .map((field) => ({
      path: field,
      message: "Bedrock credential fields are only valid for aws-bedrock-converse providers."
    }));
  if (issues.length > 0) {
    throw new ProviderCredentialAdminError("invalid_provider_credential_request", 400, issues);
  }
}

function rejectSecretFieldsForCredentialMode(
  body: Pick<CreateCredentialBody | UpdateCredentialBody, "apiKey" | "accessKeyId" | "secretAccessKey" | "sessionToken">,
  credentialMode: BedrockCredentialMode
) {
  const issues = [
    body.apiKey !== undefined ? { path: "apiKey", message: `${credentialMode} does not store an API key.` } : undefined,
    body.accessKeyId !== undefined ? { path: "accessKeyId", message: `${credentialMode} does not store static access keys.` } : undefined,
    body.secretAccessKey !== undefined ? { path: "secretAccessKey", message: `${credentialMode} does not store static access keys.` } : undefined,
    body.sessionToken !== undefined ? { path: "sessionToken", message: `${credentialMode} does not store static access keys.` } : undefined
  ].filter((issue): issue is { path: string; message: string } => Boolean(issue));
  if (issues.length > 0) {
    throw new ProviderCredentialAdminError("invalid_bedrock_provider_credential", 400, issues);
  }
}

function rejectStaticKeyFieldsForBearer(
  body: Pick<CreateCredentialBody | UpdateCredentialBody, "accessKeyId" | "secretAccessKey" | "sessionToken">
) {
  const issues = [
    body.accessKeyId !== undefined ? { path: "accessKeyId", message: "Bearer-token Bedrock credentials do not use static access keys." } : undefined,
    body.secretAccessKey !== undefined ? { path: "secretAccessKey", message: "Bearer-token Bedrock credentials do not use static access keys." } : undefined,
    body.sessionToken !== undefined ? { path: "sessionToken", message: "Bearer-token Bedrock credentials do not use static access keys." } : undefined
  ].filter((issue): issue is { path: string; message: string } => Boolean(issue));
  if (issues.length > 0) {
    throw new ProviderCredentialAdminError("invalid_bedrock_provider_credential", 400, issues);
  }
}

function bedrockCredentialSettings(settings: unknown) {
  if (!isRecord(settings)) return {};
  return {
    credentialMode: bedrockCredentialModeValue(settings.credentialMode),
    region: stringValue(settings.region),
    discoveryRegions: arrayStringValue(settings.discoveryRegions),
    endpointOverride: stringValue(settings.endpointOverride)
  };
}

function bedrockCredentialModeValue(value: unknown) {
  return BEDROCK_CREDENTIAL_MODES.find((mode) => mode === value);
}

function arrayStringValue(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function bedrockEndpointOverride(body: UpdateCredentialBody, existing: string | undefined) {
  if (body.endpointOverride !== undefined) return body.endpointOverride ?? undefined;
  if (body.baseUrl !== undefined) return body.baseUrl ?? undefined;
  return existing;
}

function hasStaticKeyUpdate(body: UpdateCredentialBody) {
  return body.accessKeyId !== undefined ||
    body.secretAccessKey !== undefined ||
    body.sessionToken !== undefined;
}

function requiredEncryptionKey(options: ProviderCredentialOptions) {
  if (!options.encryptionKey) {
    throw new ProviderCredentialAdminError("provider_secret_encryption_key_missing", 503);
  }
  return options.encryptionKey;
}

function requiredBodyString(value: string | undefined, path: string) {
  if (value) return value;
  throw fieldError("invalid_provider_credential_request", path, "Required");
}

function requiredCredentialMode(value: BedrockCredentialMode | undefined) {
  if (value) return value;
  throw fieldError("invalid_bedrock_provider_credential", "credentialMode", "Bedrock provider accounts require a credentialMode.");
}

function requiredRegion(value: string | undefined, path: string) {
  if (!value) throw fieldError("invalid_bedrock_provider_credential", path, "Bedrock provider accounts require a region.");
  if (!validAwsRegion(value)) throw fieldError("invalid_bedrock_provider_credential", path, "Expected an AWS region such as us-east-1.");
  return value;
}

function uniqueRegions(values: string[], path: string) {
  if (values.length === 0) {
    throw fieldError("invalid_bedrock_provider_credential", path, "Expected at least one discovery region.");
  }
  const regions = values.map((value, index) => requiredRegion(value, `${path}.${index}`));
  return [...new Set(regions)];
}

function validAwsRegion(value: string) {
  return /^[a-z]{2}(-gov)?-[a-z0-9-]+-\d+$/.test(value);
}

function fieldError(code: string, path: string, message: string) {
  return new ProviderCredentialAdminError(code, 400, [{ path, message }]);
}

function parseOAuthCredential(data: SecretBackedCreateCredentialBody) {
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
    .select({
      id: providers.id,
      slug: providers.slug,
      organizationId: providers.organizationId,
      adapterKind: providers.adapterKind,
      authStyle: providers.authStyle
    })
    .from(providers)
    .where(and(
      eq(providers.organizationId, organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  if (orgProvider) return orgProvider;
  const [builtinProvider] = await tx
    .select({
      id: providers.id,
      slug: providers.slug,
      organizationId: providers.organizationId,
      adapterKind: providers.adapterKind,
      authStyle: providers.authStyle
    })
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

async function validateCredentialBaseUrl(baseUrl: string, options: ProviderCredentialOptions, path = "baseUrl") {
  try {
    await validateProviderBaseUrl(baseUrl, options);
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      throw new ProviderCredentialAdminError(error.code, 400, [
        { path, message: error.message }
      ]);
    }
    throw error;
  }
}
