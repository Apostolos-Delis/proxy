import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  DIALECT_NAMES,
  LOGICAL_MODEL_RESOLUTION_KINDS,
  PROVIDER_ADAPTER_CONTRACT_VERSIONS,
  PROVIDER_ADAPTER_KINDS,
  PROVIDER_AUTH_STYLES,
  gatewayAccessProfileLimitsSchema,
  jsonValueSchema,
  gatewayModelCapabilitiesSchema,
  gatewayOperationIdSchema,
  gatewayParameterCapsSchema
} from "@proxy/schema";

import { GatewayConfigAdminError } from "./gatewayConfigTypes.js";
import { assertSafeNonSecretConfig, NonSecretConfigError } from "./nonSecretConfig.js";

export const idSchema = z.string().trim().min(1).max(1_024);
export const slugSchema = z.string().trim().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const nameSchema = z.string().trim().min(1).max(256);
export const optionalTextSchema = z.string().trim().min(1).max(2_000).nullable().optional();
export const jsonObjectSchema = jsonObjectPreflightSchema()
  .pipe(z.record(z.string().min(1).max(128), jsonValueSchema));
export const capabilitiesSchema = gatewayModelCapabilitiesSchema.superRefine((value, context) => {
  if (Object.keys(value).length > 64 || jsonByteLength(value) > 16_384) {
    context.addIssue({ code: "custom", message: "Model capabilities exceed the configured bound." });
  }
});
export const nonSecretJsonObjectSchema = jsonObjectSchema.superRefine(assertNonSecretSchema);
export const nonSecretCapabilitiesSchema = capabilitiesSchema.superRefine(assertNonSecretSchema);

const defaultHeadersSchema = z.record(
  z.string().trim().min(1).max(256),
  z.string().max(8_192)
).refine((headers) => Object.keys(headers).length <= 64, "At most 64 default headers are allowed.");
export const secretReferenceSchema = z.string().trim().max(2_048).refine(
  (value) => isSecretReference(value),
  "Secret references must use env:NAME or a scheme://locator format."
);
const hasDefinedField = (body: Record<string, unknown>) => Object.values(body).some((value) => value !== undefined);

export const providerConnectionCreateSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  adapterKind: z.enum(PROVIDER_ADAPTER_KINDS),
  authStyle: z.enum(PROVIDER_AUTH_STYLES),
  baseUrl: z.string().trim().url().max(2_048),
  region: z.string().trim().min(1).max(128).nullable().optional(),
  secretRef: secretReferenceSchema.optional(),
  secret: z.string().min(1).max(65_536).optional(),
  adapterConfig: jsonObjectSchema.default({}),
  defaultHeaders: defaultHeadersSchema.default({}),
  enabled: z.boolean().default(false)
}).superRefine(connectionCredentialIssues);

export const providerConnectionUpdateSchema = z.strictObject({
  name: nameSchema.optional(),
  authStyle: z.enum(PROVIDER_AUTH_STYLES).optional(),
  baseUrl: z.string().trim().url().max(2_048).optional(),
  region: z.string().trim().min(1).max(128).nullable().optional(),
  secretRef: secretReferenceSchema.optional(),
  secret: z.string().min(1).max(65_536).optional(),
  clearSecret: z.boolean().optional(),
  adapterConfig: jsonObjectSchema.optional(),
  defaultHeaders: defaultHeadersSchema.optional()
}).refine(hasDefinedField, "At least one field is required.")
  .superRefine(connectionCredentialIssues);

export const canonicalModelCreateSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  vendor: z.string().trim().min(1).max(128),
  family: z.string().trim().min(1).max(256),
  release: z.string().trim().min(1).max(256).nullable().optional(),
  capabilities: capabilitiesSchema.default({}),
  enabled: z.boolean().default(false)
});
export const canonicalModelUpdateSchema = z.strictObject({
  name: nameSchema.optional()
}).refine(hasDefinedField, "At least one field is required.");

export const modelDeploymentCreateSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  canonicalModelId: idSchema,
  providerConnectionId: idSchema,
  upstreamModelId: z.string().trim().min(1).max(512),
  region: z.string().trim().min(1).max(128).nullable().optional(),
  config: jsonObjectSchema.default({}),
  capabilities: capabilitiesSchema.default({}),
  pricing: jsonObjectSchema.default({}),
  enabled: z.boolean().default(false)
});
export const modelDeploymentUpdateSchema = z.strictObject({
  name: nameSchema.optional(),
  upstreamModelId: z.string().trim().min(1).max(512).optional(),
  region: z.string().trim().min(1).max(128).nullable().optional(),
  config: jsonObjectSchema.optional(),
  capabilities: capabilitiesSchema.optional(),
  pricing: jsonObjectSchema.optional()
}).refine(hasDefinedField, "At least one field is required.");

export const wireBindingCreateSchema = z.strictObject({
  deploymentId: idSchema,
  apiWireId: z.enum(DIALECT_NAMES),
  endpointPath: z.string().trim().min(1).max(1_024).nullable().optional(),
  requestConfig: jsonObjectSchema.default({}),
  adapterContractVersion: z.enum(PROVIDER_ADAPTER_CONTRACT_VERSIONS).default("1"),
  enabled: z.boolean().default(false)
});
export const wireBindingUpdateSchema = z.strictObject({
  endpointPath: z.string().trim().min(1).max(1_024).nullable().optional(),
  requestConfig: jsonObjectSchema.optional(),
  adapterContractVersion: z.enum(PROVIDER_ADAPTER_CONTRACT_VERSIONS).optional()
}).refine(hasDefinedField, "At least one field is required.");

export const logicalModelCreateSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  description: optionalTextSchema,
  resolutionKind: z.enum(LOGICAL_MODEL_RESOLUTION_KINDS),
  routerConfig: jsonObjectSchema.default({}),
  enabled: z.boolean().default(false)
});
export const logicalModelUpdateSchema = z.strictObject({
  name: nameSchema.optional(),
  description: optionalTextSchema,
  resolutionKind: z.enum(LOGICAL_MODEL_RESOLUTION_KINDS).optional(),
  routerConfig: jsonObjectSchema.optional()
}).refine(hasDefinedField, "At least one field is required.");

export const logicalModelTargetCreateSchema = z.strictObject({
  logicalModelId: idSchema,
  deploymentId: idSchema,
  priority: z.number().int().nonnegative().max(1_000_000),
  enabled: z.boolean().default(false)
});
export const logicalModelTargetUpdateSchema = z.strictObject({
  deploymentId: idSchema.optional(),
  priority: z.number().int().nonnegative().max(1_000_000).optional()
}).refine(hasDefinedField, "At least one field is required.");

export const accessProfileCreateSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  description: optionalTextSchema,
  limits: gatewayAccessProfileLimitsSchema.default({}),
  enabled: z.boolean().default(false)
});
export const accessProfileUpdateSchema = z.strictObject({
  name: nameSchema.optional(),
  description: optionalTextSchema,
  limits: gatewayAccessProfileLimitsSchema.optional()
}).refine(hasDefinedField, "At least one field is required.");

export const modelGrantCreateSchema = z.strictObject({
  accessProfileId: idSchema,
  logicalModelId: idSchema,
  allowedOperations: z.array(gatewayOperationIdSchema).min(1).max(3),
  parameterCaps: gatewayParameterCapsSchema.default({}),
  enabled: z.boolean().default(false)
});
export const modelGrantUpdateSchema = z.strictObject({
  allowedOperations: z.array(gatewayOperationIdSchema).min(1).max(3).optional(),
  parameterCaps: gatewayParameterCapsSchema.optional()
}).refine(hasDefinedField, "At least one field is required.");

export function parseGatewayBody<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new GatewayConfigAdminError(message, 400, parsed.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message
  })));
}

type ConnectionCredentialInput = {
  secretRef?: string;
  secret?: string;
  clearSecret?: boolean;
};

function connectionCredentialIssues(body: ConnectionCredentialInput, context: z.RefinementCtx) {
  const configured = [Boolean(body.secretRef), Boolean(body.secret), body.clearSecret === true]
    .filter(Boolean).length;
  if (configured > 1) {
    context.addIssue({
      code: "custom",
      path: ["secret"],
      message: "Set only one of secretRef, secret, or clearSecret."
    });
  }
}

function assertNonSecretSchema(value: Record<string, unknown>, context: z.RefinementCtx) {
  try {
    assertSafeNonSecretConfig(value);
  } catch (error) {
    if (!(error instanceof NonSecretConfigError)) throw error;
    context.addIssue({ code: "custom", path: [error.field], message: error.message });
  }
}

function jsonByteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function jsonObjectPreflightSchema() {
  return z.unknown().superRefine((value, context) => {
    const error = validateJsonObject(value);
    if (error) context.addIssue({ code: "custom", message: error });
  });
}

function validateJsonObject(value: unknown) {
  if (!isPlainRecord(value)) return "Expected a JSON object.";
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const ancestors = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.exit) {
      ancestors.delete(current.value as object);
      continue;
    }
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return "JSON numbers must be finite.";
      continue;
    }
    if (typeof current.value !== "object") return "JSON values must be null, booleans, finite numbers, strings, arrays, or objects.";
    if (current.depth > 64) return "JSON objects cannot exceed 64 levels of nesting.";
    if (ancestors.has(current.value)) return "JSON objects cannot contain cycles.";
    ancestors.add(current.value);
    if (!Array.isArray(current.value) && !isPlainRecord(current.value)) return "JSON objects cannot contain class instances.";
    let entries: unknown[];
    try {
      entries = Object.values(current.value);
    } catch {
      return "JSON object properties could not be read.";
    }
    stack.push({ ...current, exit: true });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
  try {
    if (jsonByteLength(value) > 65_536) return "JSON object exceeds 65,536 bytes.";
  } catch {
    return "JSON object could not be serialized.";
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isSecretReference(value: string) {
  if (/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) return false;
  const authority = value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0];
  return Boolean(authority) && !authority!.includes("@");
}
