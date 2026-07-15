import { z } from "zod";

import {
  canonicalModels,
  encryptSecret,
  providerConnections,
  secretHint
} from "@proxy/db";

import { createId } from "../util.js";
import {
  canonicalModelCreateSchema,
  canonicalModelUpdateSchema,
  parseGatewayBody,
  providerConnectionCreateSchema,
  providerConnectionUpdateSchema
} from "./gatewayConfigSchemas.js";
import {
  assertNonSecretJson,
  assertSlugAvailable,
  fieldError,
  GatewayConfigQueryStore,
  lockScopedRow,
  scopedId,
  setStatus
} from "./gatewayConfigStore.js";
import {
  GatewayConfigAdminError,
  type GatewayConfigActor,
  type GatewayConfigAdminOptions,
  type GatewayConfigCommand,
  type GatewayConfigMutationContext
} from "./gatewayConfigTypes.js";
import { assertSafeNonSecretConfig, NonSecretConfigError } from "./nonSecretConfig.js";
import {
  assertProviderAdapterConfig,
  assertSafeDefaultHeaders,
  ProviderRegistryError,
  trimProviderBaseUrl,
  validateProviderBaseUrl,
  validateProviderBaseUrlShape,
  type ProviderNetworkPolicy
} from "./providers.js";

export async function preflightProviderCommands(
  queries: GatewayConfigQueryStore,
  options: GatewayConfigAdminOptions,
  input: GatewayConfigActor & { commands: GatewayConfigCommand[] }
) {
  const projectedBaseUrls = new Map<string, string>();
  for (const command of input.commands) {
    if (command.resource !== "providerConnection") continue;
    if (command.action === "create") {
      const body = parseGatewayBody(providerConnectionCreateSchema, command.body, "invalid_provider_connection");
      await validateConnectionNetwork(trimProviderBaseUrl(body.baseUrl), options);
      continue;
    }
    if (command.action === "update") {
      const body = parseGatewayBody(providerConnectionUpdateSchema, command.body, "invalid_provider_connection");
      if (body.baseUrl) {
        const baseUrl = trimProviderBaseUrl(body.baseUrl);
        await validateConnectionNetwork(baseUrl, options);
        projectedBaseUrls.set(command.id, baseUrl);
      }
      continue;
    }
    if (command.enabled) {
      if (projectedBaseUrls.has(command.id)) continue;
      const current = await queries.providerConnectionRecord(input, command.id);
      await validateConnectionNetwork(current.baseUrl, options);
    }
  }
}

export async function createProviderConnection(context: GatewayConfigMutationContext, input: unknown) {
  const { tx, actor, options } = context;
  const body = parseGatewayBody(providerConnectionCreateSchema, input, "invalid_provider_connection");
  const baseUrl = trimProviderBaseUrl(body.baseUrl);
  assertCredentialInputAllowed(body.authStyle, body);
  const credential = encryptedCredential(body.secretRef, body.secret, options.encryptionKey);
  validateConnectionState({ ...body, baseUrl, ...credential }, options);
  await assertSlugAvailable(tx, providerConnections, actor, body.slug, "provider_connection_slug_exists");
  const id = createId("connection");
  const now = new Date();
  await tx.insert(providerConnections).values({
    id,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    slug: body.slug,
    name: body.name,
    adapterKind: body.adapterKind,
    authStyle: body.authStyle,
    baseUrl,
    region: body.region ?? null,
    ...credential,
    adapterConfig: body.adapterConfig,
    defaultHeaders: body.defaultHeaders,
    status: body.enabled ? "active" : "disabled",
    createdAt: now,
    updatedAt: now
  });
  await context.appendEvent("provider_connection", id, "created", {
    id,
    slug: body.slug,
    name: body.name,
    adapterKind: body.adapterKind,
    authStyle: body.authStyle,
    baseUrl,
    region: body.region ?? null,
    credential: credentialKind(credential),
    adapterConfig: body.adapterConfig,
    defaultHeaders: body.defaultHeaders,
    status: body.enabled ? "active" : "disabled"
  }, now);
  return { resource: "providerConnection" as const, id };
}

export async function updateProviderConnection(
  context: GatewayConfigMutationContext,
  id: string,
  input: unknown
) {
  const { tx, actor, options } = context;
  const body = parseGatewayBody(providerConnectionUpdateSchema, input, "invalid_provider_connection");
  const current = await lockScopedRow(tx, providerConnections, actor, id, "provider_connection_not_found");
  const authStyle = body.authStyle ?? current.authStyle;
  assertCredentialInputAllowed(authStyle, body);
  let credential = {
    secretRef: current.secretRef,
    secretCiphertext: current.secretCiphertext,
    secretHint: current.secretHint
  };
  if (body.clearSecret) credential = { secretRef: null, secretCiphertext: null, secretHint: null };
  if (body.secretRef) credential = { secretRef: body.secretRef, secretCiphertext: null, secretHint: null };
  if (body.secret) credential = encryptedCredential(undefined, body.secret, options.encryptionKey);
  if (authStyle === "none") credential = { secretRef: null, secretCiphertext: null, secretHint: null };
  const baseUrl = trimProviderBaseUrl(body.baseUrl ?? current.baseUrl);
  assertOriginCredentialReplacement(current, body, baseUrl);
  const next = {
    slug: current.slug,
    name: body.name ?? current.name,
    adapterKind: current.adapterKind,
    authStyle,
    baseUrl,
    region: body.region === undefined ? current.region : body.region,
    adapterConfig: body.adapterConfig ?? current.adapterConfig,
    defaultHeaders: body.defaultHeaders ?? current.defaultHeaders,
    enabled: current.status === "active",
    ...credential
  };
  validateConnectionState(next, options);
  const now = new Date();
  await tx.update(providerConnections).set({
    name: next.name,
    authStyle: next.authStyle,
    baseUrl: next.baseUrl,
    region: next.region,
    ...credential,
    adapterConfig: next.adapterConfig,
    defaultHeaders: next.defaultHeaders,
    updatedAt: now
  }).where(scopedId(providerConnections, actor, id));
  await context.appendEvent("provider_connection", id, "updated", {
    id,
    slug: current.slug,
    name: next.name,
    adapterKind: current.adapterKind,
    authStyle: next.authStyle,
    baseUrl: next.baseUrl,
    region: next.region,
    credential: credentialKind(credential),
    adapterConfig: next.adapterConfig,
    defaultHeaders: next.defaultHeaders,
    status: current.status
  }, now);
  return { resource: "providerConnection" as const, id };
}

export async function setProviderConnectionEnabled(
  context: GatewayConfigMutationContext,
  id: string,
  enabled: boolean
) {
  const { tx, actor, options } = context;
  const current = await lockScopedRow(tx, providerConnections, actor, id, "provider_connection_not_found");
  if (enabled) validateConnectionState({ ...current, enabled }, options);
  await setStatus(tx, providerConnections, actor, id, enabled);
  await context.appendEvent("provider_connection", id, enabled ? "enabled" : "disabled", {
    id,
    slug: current.slug,
    status: enabled ? "active" : "disabled"
  });
  return { resource: "providerConnection" as const, id };
}

export async function createCanonicalModel(context: GatewayConfigMutationContext, input: unknown) {
  const { tx, actor } = context;
  const body = parseGatewayBody(canonicalModelCreateSchema, input, "invalid_canonical_model");
  assertNonSecretJson(body.capabilities, "capabilities");
  await assertSlugAvailable(tx, canonicalModels, actor, body.slug, "canonical_model_slug_exists");
  const id = createId("canonical_model");
  const now = new Date();
  await tx.insert(canonicalModels).values({
    id,
    organizationId: actor.organizationId,
    workspaceId: actor.workspaceId,
    slug: body.slug,
    name: body.name,
    vendor: body.vendor,
    family: body.family,
    release: body.release ?? null,
    capabilities: body.capabilities,
    status: body.enabled ? "active" : "disabled",
    createdAt: now,
    updatedAt: now
  });
  await context.appendEvent("canonical_model", id, "created", {
    id,
    ...body,
    release: body.release ?? null,
    status: body.enabled ? "active" : "disabled"
  }, now);
  return { resource: "canonicalModel" as const, id };
}

export async function updateCanonicalModel(context: GatewayConfigMutationContext, id: string, input: unknown) {
  const { tx, actor } = context;
  const body = parseGatewayBody(canonicalModelUpdateSchema, input, "invalid_canonical_model");
  const current = await lockScopedRow(tx, canonicalModels, actor, id, "canonical_model_not_found");
  const now = new Date();
  await tx.update(canonicalModels).set({ name: body.name ?? current.name, updatedAt: now })
    .where(scopedId(canonicalModels, actor, id));
  await context.appendEvent("canonical_model", id, "updated", {
    id,
    slug: current.slug,
    name: body.name ?? current.name,
    vendor: current.vendor,
    family: current.family,
    release: current.release,
    capabilities: current.capabilities,
    status: current.status
  }, now);
  return { resource: "canonicalModel" as const, id };
}

export async function setCanonicalModelEnabled(
  context: GatewayConfigMutationContext,
  id: string,
  enabled: boolean
) {
  const { tx, actor } = context;
  const current = await lockScopedRow(tx, canonicalModels, actor, id, "canonical_model_not_found");
  await setStatus(tx, canonicalModels, actor, id, enabled);
  await context.appendEvent("canonical_model", id, enabled ? "enabled" : "disabled", {
    id,
    slug: current.slug,
    status: enabled ? "active" : "disabled"
  });
  return { resource: "canonicalModel" as const, id };
}

function encryptedCredential(secretRef: string | undefined, secret: string | undefined, encryptionKey: string | undefined) {
  if (secretRef) return { secretRef, secretCiphertext: null, secretHint: null };
  if (!secret) return { secretRef: null, secretCiphertext: null, secretHint: null };
  if (!encryptionKey) throw new GatewayConfigAdminError("provider_secret_encryption_key_missing", 400);
  try {
    return {
      secretRef: null,
      secretCiphertext: encryptSecret(secret, encryptionKey),
      secretHint: secretHint(secret)
    };
  } catch (error) {
    throw new GatewayConfigAdminError(error instanceof Error ? error.message : "provider_secret_encryption_failed", 400);
  }
}

function credentialKind(credential: { secretRef: string | null; secretCiphertext: string | null }) {
  if (credential.secretRef) return "reference";
  if (credential.secretCiphertext) return "encrypted";
  return "none";
}

function assertCredentialInputAllowed(
  authStyle: string,
  body: { secretRef?: string; secret?: string }
) {
  if (authStyle === "none" && (body.secretRef || body.secret)) {
    throw fieldError(
      "provider_connection_credential_forbidden",
      "secret",
      "Unauthenticated connections cannot accept credentials."
    );
  }
}

function validateConnectionState(
  body: {
    slug: string;
    adapterKind: string;
    authStyle: string;
    baseUrl: string;
    adapterConfig: Record<string, unknown>;
    defaultHeaders: Record<string, string>;
    enabled: boolean;
    secretRef: string | null;
    secretCiphertext: string | null;
  },
  options: GatewayConfigAdminOptions
) {
  if (body.adapterKind === "generic-http-json" && !["bearer", "x-api-key", "none"].includes(body.authStyle)) {
    throw fieldError("invalid_provider_connection_adapter", "authStyle", "Generic HTTP connections require bearer, x-api-key, or no authentication.");
  }
  if (body.adapterKind === "aws-bedrock-converse" && body.authStyle !== "aws-sdk") {
    throw fieldError("invalid_provider_connection_adapter", "authStyle", "Bedrock connections require aws-sdk authentication.");
  }
  if (body.enabled && ["bearer", "x-api-key"].includes(body.authStyle) && !body.secretRef && !body.secretCiphertext) {
    throw fieldError("provider_connection_credential_missing", "secret", "An active authenticated connection requires a credential.");
  }
  if (body.authStyle === "none" && (body.secretRef || body.secretCiphertext)) {
    throw fieldError("provider_connection_credential_forbidden", "secret", "Unauthenticated connections cannot retain credentials.");
  }
  if (body.secretRef && !options.secretReferenceSupported?.({
    reference: body.secretRef,
    provider: body.slug,
    baseUrl: body.baseUrl
  })) {
    throw fieldError(
      "provider_connection_secret_reference_unsupported",
      "secretRef",
      "The secret reference is not available for this provider and origin."
    );
  }
  try {
    assertProviderAdapterConfig(body.adapterKind as "generic-http-json" | "aws-bedrock-converse", body.adapterConfig);
    assertSafeDefaultHeaders(body.defaultHeaders);
    assertSafeNonSecretConfig(body.adapterConfig);
    validateProviderBaseUrlShape(body.baseUrl);
  } catch (error) {
    if (error instanceof NonSecretConfigError) {
      throw fieldError("provider_adapter_config_secret_forbidden", "adapterConfig", error.message);
    }
    if (error instanceof ProviderRegistryError) {
      throw fieldError(error.code, providerValidationPath(error.code), error.message);
    }
    throw error;
  }
}

async function validateConnectionNetwork(baseUrl: string, policy: ProviderNetworkPolicy) {
  try {
    await validateProviderBaseUrl(baseUrl, policy);
  } catch (error) {
    if (error instanceof ProviderRegistryError) throw fieldError(error.code, "baseUrl", error.message);
    throw error;
  }
}

function assertOriginCredentialReplacement(
  current: typeof providerConnections.$inferSelect,
  body: z.infer<typeof providerConnectionUpdateSchema>,
  nextBaseUrl: string
) {
  if (new URL(current.baseUrl).origin === new URL(nextBaseUrl).origin) return;
  const credentialRetained = Boolean(current.secretRef || current.secretCiphertext);
  const credentialReplaced = Boolean(body.secretRef || body.secret || body.clearSecret || body.authStyle === "none");
  if (credentialRetained && !credentialReplaced) {
    throw fieldError(
      "provider_connection_origin_credential_replacement_required",
      "baseUrl",
      "Changing provider origin requires replacing or clearing the credential."
    );
  }
}

function providerValidationPath(code: string) {
  if (code === "provider_adapter_config_invalid") return "adapterConfig";
  if (code === "provider_default_header_forbidden" || code === "provider_default_header_invalid") {
    return "defaultHeaders";
  }
  return "baseUrl";
}
