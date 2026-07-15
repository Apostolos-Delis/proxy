import { randomUUID } from "node:crypto";

import { providers, type ProxyTransaction, type ProxyTransactionalDatabase } from "@proxy/db";
import {
  BEDROCK_PROVIDER_OPERATIONS,
  HTTP_PROVIDER_DIALECT_NAMES,
  PROVIDER_ADAPTER_KINDS,
  PROVIDER_AUTH_STYLES,
  providerCapabilitiesSchema
} from "@proxy/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { AdminMutationError } from "./adminErrors.js";
import { appendAdminAuditEvent } from "./adminAudit.js";
import {
  assertProviderAdapterConfig,
  assertSafeDefaultHeaders,
  ProviderRegistryError,
  trimProviderBaseUrl,
  validateProviderBaseUrl,
  type ProviderNetworkPolicy
} from "./providers.js";

const httpEndpointBodySchema = z.object({
  dialect: z.enum(HTTP_PROVIDER_DIALECT_NAMES),
  path: z.string().trim().min(1).refine((value) => value.startsWith("/"), {
    message: "Endpoint path must start with '/'."
  })
}).strict();

const bedrockEndpointBodySchema = z.object({
  dialect: z.literal("bedrock-converse"),
  operation: z.enum(BEDROCK_PROVIDER_OPERATIONS)
}).strict();

const endpointBodySchema = z.union([httpEndpointBodySchema, bedrockEndpointBodySchema]);

const capabilitiesBodySchema = providerCapabilitiesSchema.default({});

const providerBodySchema = z.object({
  slug: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1),
  adapterKind: z.enum(PROVIDER_ADAPTER_KINDS).default("generic-http-json"),
  adapterConfig: z.record(z.string(), z.unknown()).default({}),
  authStyle: z.enum(PROVIDER_AUTH_STYLES),
  endpoints: z.array(endpointBodySchema).min(1),
  defaultHeaders: z.record(z.string().trim().min(1), z.string().trim().min(1)).default({}),
  capabilities: capabilitiesBodySchema,
  forwardHarnessHeaders: z.boolean().default(false),
  enabled: z.boolean().default(true)
}).strict();

const providerUpdateBodySchema = providerBodySchema.omit({ slug: true });

export class ProviderRegistryAdminError extends AdminMutationError {}

export class ProviderRegistryAdminService {
  constructor(
    private readonly db: ProxyTransactionalDatabase,
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
        adapterKind: body.data.adapterKind,
        adapterConfig: body.data.adapterConfig,
        authStyle: body.data.authStyle,
        endpoints: body.data.endpoints,
        defaultHeaders: body.data.defaultHeaders,
        capabilities: body.data.capabilities,
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
        producer: "proxy.admin.providers",
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
          adapterKind: body.data.adapterKind,
          adapterConfig: body.data.adapterConfig,
          authStyle: body.data.authStyle,
          endpoints: body.data.endpoints,
          defaultHeaders: body.data.defaultHeaders,
          capabilities: body.data.capabilities,
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
        producer: "proxy.admin.providers",
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
        producer: "proxy.admin.providers",
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
  const compatibilityIssues = providerAdapterCompatibilityIssues(body);
  if (compatibilityIssues.length > 0) {
    throw new ProviderRegistryAdminError("invalid_provider_adapter", 400, compatibilityIssues);
  }
  try {
    assertProviderAdapterConfig(body.adapterKind, body.adapterConfig);
    assertSafeDefaultHeaders(body.defaultHeaders);
    await validateProviderBaseUrl(body.baseUrl, networkPolicy);
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      let path = "baseUrl";
      if (error.code === "provider_adapter_config_invalid") path = "adapterConfig";
      if (error.code === "provider_default_header_forbidden" || error.code === "provider_default_header_invalid") {
        path = "defaultHeaders";
      }
      throw new ProviderRegistryAdminError(error.code, 400, [
        { path, message: error.message }
      ]);
    }
    throw error;
  }
}

function providerAdapterCompatibilityIssues(body: ProviderBody | ProviderUpdateBody) {
  const issues: { path: string; message: string }[] = [];
  if (body.adapterKind === "generic-http-json" && body.authStyle === "aws-sdk") {
    issues.push({ path: "authStyle", message: "aws-sdk auth requires the aws-bedrock-converse adapter." });
  }
  if (body.adapterKind === "aws-bedrock-converse" && body.authStyle !== "aws-sdk") {
    issues.push({ path: "authStyle", message: "Bedrock providers must use aws-sdk auth." });
  }
  body.endpoints.forEach((endpoint, index) => {
    if (body.adapterKind === "generic-http-json" && "operation" in endpoint) {
      issues.push({ path: `endpoints.${index}.operation`, message: "Generic HTTP providers must use path endpoints." });
    }
    if (body.adapterKind === "aws-bedrock-converse" && "path" in endpoint) {
      issues.push({ path: `endpoints.${index}.path`, message: "Bedrock providers must use operation endpoints." });
    }
  });
  return issues;
}

async function orgProviderBySlug(tx: ProxyTransaction, organizationId: string, slug: string) {
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

async function editableProviderById(tx: ProxyTransaction, organizationId: string, providerId: string) {
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
    adapterKind: body.adapterKind,
    adapterConfig: body.adapterConfig,
    authStyle: body.authStyle,
    endpoints: body.endpoints,
    defaultHeaders: body.defaultHeaders,
    capabilities: body.capabilities,
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
