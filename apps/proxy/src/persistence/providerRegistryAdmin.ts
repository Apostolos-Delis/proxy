import { randomUUID } from "node:crypto";

import { providers, type PromptProxyTransaction, type PromptProxyTransactionalDatabase } from "@prompt-proxy/db";
import { DIALECT_NAMES, PROVIDER_AUTH_STYLES } from "@prompt-proxy/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { AdminMutationError } from "./adminErrors.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import {
  assertSafeDefaultHeaders,
  ProviderRegistryError,
  trimProviderBaseUrl,
  validateProviderBaseUrl,
  type ProviderNetworkPolicy
} from "./providers.js";

const endpointBodySchema = z.object({
  dialect: z.enum(DIALECT_NAMES),
  path: z.string().trim().min(1).refine((value) => value.startsWith("/"), {
    message: "Endpoint path must start with '/'."
  })
}).strict();

const providerBodySchema = z.object({
  slug: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1),
  authStyle: z.enum(PROVIDER_AUTH_STYLES),
  endpoints: z.array(endpointBodySchema).min(1),
  defaultHeaders: z.record(z.string().trim().min(1), z.string().trim().min(1)).default({}),
  forwardHarnessHeaders: z.boolean().default(false),
  enabled: z.boolean().default(true)
}).strict();

const providerUpdateBodySchema = providerBodySchema.omit({ slug: true });

export class ProviderRegistryAdminError extends AdminMutationError {}

export class ProviderRegistryAdminService {
  constructor(
    private readonly db: PromptProxyTransactionalDatabase,
    private readonly networkPolicy: ProviderNetworkPolicy
  ) {}

  async createProvider(input: {
    organizationId: string;
    actorUserId: string;
    body: unknown;
  }) {
    const body = providerBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_provider_request", body.error);
    await validateProviderBody(body.data, this.networkPolicy);
    const providerId = randomUUID();
    const now = new Date();

    return this.db.transaction(async (tx) => {
      const existing = await orgProviderBySlug(tx, input.organizationId, body.data.slug);
      if (existing) throw new ProviderRegistryAdminError("provider_slug_exists", 409, [
        { path: "slug", message: "Provider slug already exists." }
      ]);

      await tx.insert(providers).values({
        id: providerId,
        organizationId: input.organizationId,
        slug: body.data.slug,
        displayName: body.data.displayName,
        baseUrl: trimProviderBaseUrl(body.data.baseUrl),
        authStyle: body.data.authStyle,
        endpoints: body.data.endpoints,
        defaultHeaders: body.data.defaultHeaders,
        forwardHarnessHeaders: body.data.forwardHarnessHeaders,
        enabled: body.data.enabled,
        createdAt: now,
        updatedAt: now
      });
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "provider",
        scopeId: providerId,
        correlationId: providerId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.providers",
        eventType: "provider.created",
        payload: providerPayload(providerId, body.data),
        createdAt: now
      });

      return { providerId };
    });
  }

  async updateProvider(input: {
    organizationId: string;
    actorUserId: string;
    providerId: string;
    body: unknown;
  }) {
    const body = providerUpdateBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_provider_request", body.error);
    await validateProviderBody(body.data, this.networkPolicy);
    const now = new Date();

    return this.db.transaction(async (tx) => {
      const existing = await editableProviderById(tx, input.organizationId, input.providerId);
      await tx
        .update(providers)
        .set({
          displayName: body.data.displayName,
          baseUrl: trimProviderBaseUrl(body.data.baseUrl),
          authStyle: body.data.authStyle,
          endpoints: body.data.endpoints,
          defaultHeaders: body.data.defaultHeaders,
          forwardHarnessHeaders: body.data.forwardHarnessHeaders,
          enabled: body.data.enabled,
          updatedAt: now
        })
        .where(and(
          eq(providers.organizationId, input.organizationId),
          eq(providers.id, input.providerId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "provider",
        scopeId: input.providerId,
        correlationId: input.providerId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.providers",
        eventType: "provider.updated",
        payload: {
          ...providerPayload(input.providerId, { ...body.data, slug: existing.slug }),
          previousSlug: existing.slug
        },
        createdAt: now
      });

      return { providerId: input.providerId };
    });
  }

  async disableProvider(input: {
    organizationId: string;
    actorUserId: string;
    providerId: string;
  }) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const existing = await editableProviderById(tx, input.organizationId, input.providerId);
      await tx
        .update(providers)
        .set({ enabled: false, updatedAt: now })
        .where(and(
          eq(providers.organizationId, input.organizationId),
          eq(providers.id, input.providerId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "provider",
        scopeId: input.providerId,
        correlationId: input.providerId,
        actorUserId: input.actorUserId,
        producer: "prompt-proxy.admin.providers",
        eventType: "provider.disabled",
        payload: {
          providerId: input.providerId,
          slug: existing.slug,
          displayName: existing.displayName
        },
        createdAt: now
      });

      return { providerId: input.providerId };
    });
  }
}

type ProviderBody = z.infer<typeof providerBodySchema>;
type ProviderUpdateBody = z.infer<typeof providerUpdateBodySchema>;

async function validateProviderBody(
  body: ProviderBody | ProviderUpdateBody,
  networkPolicy: ProviderNetworkPolicy
) {
  try {
    assertSafeDefaultHeaders(body.defaultHeaders);
    await validateProviderBaseUrl(body.baseUrl, networkPolicy);
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      const path = error.code === "provider_default_header_forbidden" ? "defaultHeaders" : "baseUrl";
      throw new ProviderRegistryAdminError(error.code, 400, [
        { path, message: error.message }
      ]);
    }
    throw error;
  }
}

async function orgProviderBySlug(tx: PromptProxyTransaction, organizationId: string, slug: string) {
  const [provider] = await tx
    .select({ id: providers.id })
    .from(providers)
    .where(and(
      eq(providers.organizationId, organizationId),
      eq(providers.slug, slug)
    ))
    .limit(1);
  return provider;
}

async function editableProviderById(tx: PromptProxyTransaction, organizationId: string, providerId: string) {
  const [provider] = await tx
    .select({
      id: providers.id,
      organizationId: providers.organizationId,
      slug: providers.slug,
      displayName: providers.displayName
    })
    .from(providers)
    .where(eq(providers.id, providerId))
    .limit(1);
  if (!provider) throw new ProviderRegistryAdminError("provider_not_found", 404);
  if (provider.organizationId === null) throw new ProviderRegistryAdminError("provider_builtin_readonly", 409);
  if (provider.organizationId !== organizationId) throw new ProviderRegistryAdminError("provider_not_found", 404);
  return provider;
}

function providerPayload(providerId: string, body: ProviderBody) {
  return {
    providerId,
    slug: body.slug,
    displayName: body.displayName,
    baseUrl: trimProviderBaseUrl(body.baseUrl),
    authStyle: body.authStyle,
    endpoints: body.endpoints,
    defaultHeaders: body.defaultHeaders,
    forwardHarnessHeaders: body.forwardHarnessHeaders,
    enabled: body.enabled
  };
}

function validationError(message: string, error: z.ZodError) {
  return new ProviderRegistryAdminError(
    message,
    400,
    error.issues.map((issue) => ({
      path: issue.path.join(".") || "body",
      message: issue.message
    }))
  );
}
