import { Buffer } from "node:buffer";

import { parse as parseToml, TomlError } from "smol-toml";
import { z } from "zod";

import {
  DIALECT_NAMES,
  LOGICAL_MODEL_RESOLUTION_KINDS,
  PROVIDER_ADAPTER_CONTRACT_VERSIONS,
  PROVIDER_ADAPTER_KINDS,
  PROVIDER_AUTH_STYLES,
  gatewayAccessProfileLimitsSchema,
  gatewayOperationIdSchema,
  gatewayParameterCapsSchema
} from "@proxy/schema";

import {
  idSchema,
  nameSchema,
  nonSecretCapabilitiesSchema,
  nonSecretJsonObjectSchema,
  optionalTextSchema,
  parseGatewayBody,
  secretReferenceSchema,
  slugSchema
} from "./gatewayConfigSchemas.js";
import { GatewayConfigAdminError } from "./gatewayConfigTypes.js";

const MAX_DOCUMENT_BYTES = 1_048_576;
const MAX_RESOURCES = 1_000;

const defaultHeadersSchema = z.record(
  z.string().trim().min(1).max(256),
  z.string().max(8_192)
).refine((headers) => Object.keys(headers).length <= 64, "At most 64 default headers are allowed.");

const providerConnectionSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  adapter_kind: z.enum(PROVIDER_ADAPTER_KINDS),
  auth_style: z.enum(PROVIDER_AUTH_STYLES),
  base_url: z.string().trim().url().max(2_048),
  region: z.string().trim().min(1).max(128).optional(),
  secret_ref: secretReferenceSchema.optional(),
  clear_secret: z.boolean().default(false),
  adapter_config: nonSecretJsonObjectSchema.default({}),
  default_headers: defaultHeadersSchema.default({}),
  enabled: z.boolean().default(false)
}).superRefine((value, context) => {
  if (value.secret_ref && value.clear_secret) {
    context.addIssue({
      code: "custom",
      path: ["secret_ref"],
      message: "Set only one of secret_ref or clear_secret."
    });
  }
});

const canonicalModelSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  vendor: z.string().trim().min(1).max(128),
  family: z.string().trim().min(1).max(256),
  release: z.string().trim().min(1).max(256).optional(),
  capabilities: nonSecretCapabilitiesSchema.default({}),
  enabled: z.boolean().default(false)
});

const modelDeploymentSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  canonical_model: slugSchema,
  provider_connection: slugSchema,
  upstream_model_id: z.string().trim().min(1).max(512),
  region: z.string().trim().min(1).max(128).optional(),
  config: nonSecretJsonObjectSchema.default({}),
  capabilities: nonSecretCapabilitiesSchema.default({}),
  pricing: nonSecretJsonObjectSchema.default({}),
  enabled: z.boolean().default(false)
});

const wireBindingSchema = z.strictObject({
  deployment: slugSchema,
  api_wire: z.enum(DIALECT_NAMES),
  endpoint_path: z.string().trim().min(1).max(1_024).optional(),
  request_config: nonSecretJsonObjectSchema.default({}),
  adapter_contract_version: z.enum(PROVIDER_ADAPTER_CONTRACT_VERSIONS).default("1"),
  enabled: z.boolean().default(false)
});

const logicalModelSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  description: optionalTextSchema,
  resolution_kind: z.enum(LOGICAL_MODEL_RESOLUTION_KINDS),
  router: z.strictObject({
    classifier_deployment: slugSchema,
    instructions: z.string().trim().min(1).max(20_000),
    timeout_ms: z.number().int().positive().max(30_000),
    max_attempts: z.number().int().positive().max(5)
  }).optional(),
  enabled: z.boolean().default(false)
}).superRefine((value, context) => {
  if (value.resolution_kind === "router" && !value.router) {
    context.addIssue({
      code: "custom",
      path: ["router"],
      message: "Router models require router configuration."
    });
  }
  if (value.resolution_kind === "direct" && value.router) {
    context.addIssue({
      code: "custom",
      path: ["router"],
      message: "Direct models cannot define router configuration."
    });
  }
});

const logicalModelTargetSchema = z.strictObject({
  logical_model: slugSchema,
  deployment: slugSchema,
  priority: z.number().int().nonnegative().max(1_000_000),
  enabled: z.boolean().default(false)
});

const accessProfileSchema = z.strictObject({
  slug: slugSchema,
  name: nameSchema,
  description: optionalTextSchema,
  limits: gatewayAccessProfileLimitsSchema.default({}),
  enabled: z.boolean().default(false)
});

const modelGrantSchema = z.strictObject({
  access_profile: slugSchema,
  logical_model: slugSchema,
  allowed_operations: z.array(gatewayOperationIdSchema).min(1).max(3),
  parameter_caps: gatewayParameterCapsSchema.default({}),
  enabled: z.boolean().default(false)
});

const apiKeyAssignmentSchema = z.strictObject({
  api_key_id: idSchema,
  access_profile: slugSchema
});

const gatewayConfigDocumentSchema = z.strictObject({
  version: z.literal(1),
  scope: z.strictObject({
    organization_id: idSchema,
    workspace_id: idSchema
  }),
  provider_connections: z.array(providerConnectionSchema).default([]),
  canonical_models: z.array(canonicalModelSchema).default([]),
  model_deployments: z.array(modelDeploymentSchema).default([]),
  wire_bindings: z.array(wireBindingSchema).default([]),
  logical_models: z.array(logicalModelSchema).default([]),
  logical_model_targets: z.array(logicalModelTargetSchema).default([]),
  access_profiles: z.array(accessProfileSchema).default([]),
  model_grants: z.array(modelGrantSchema).default([]),
  api_key_assignments: z.array(apiKeyAssignmentSchema).default([])
}).superRefine(validateDocumentIdentities);

export type GatewayConfigDocument = z.infer<typeof gatewayConfigDocumentSchema>;

export function parseGatewayConfigDocument(source: string): GatewayConfigDocument {
  if (Buffer.byteLength(source, "utf8") > MAX_DOCUMENT_BYTES) {
    throw parseGatewayBodyError("Gateway configuration exceeds 1 MiB.");
  }
  let parsed: unknown;
  try {
    parsed = parseToml(source, { maxDepth: 64 });
  } catch (error) {
    const location = error instanceof TomlError ? ` at line ${error.line}, column ${error.column}` : "";
    throw parseGatewayBodyError(`Invalid TOML syntax${location}.`);
  }
  return parseGatewayBody(gatewayConfigDocumentSchema, parsed, "invalid_gateway_config_document");
}

function validateDocumentIdentities(document: GatewayConfigDocument, context: z.RefinementCtx) {
  const collections: Array<[string, Array<{ slug: string }>]> = [
    ["provider_connections", document.provider_connections],
    ["canonical_models", document.canonical_models],
    ["model_deployments", document.model_deployments],
    ["logical_models", document.logical_models],
    ["access_profiles", document.access_profiles]
  ];
  for (const [name, resources] of collections) {
    addDuplicateIssues(resources.map((resource) => resource.slug), name, context);
  }
  addDuplicateIssues(
    document.wire_bindings.map((binding) => `${binding.deployment}\0${binding.api_wire}`),
    "wire_bindings",
    context
  );
  addDuplicateIssues(
    document.logical_model_targets.map((target) => `${target.logical_model}\0${target.deployment}`),
    "logical_model_targets",
    context
  );
  addDuplicateIssues(
    document.model_grants.map((grant) => `${grant.access_profile}\0${grant.logical_model}`),
    "model_grants",
    context
  );
  addDuplicateIssues(
    document.api_key_assignments.map((assignment) => assignment.api_key_id),
    "api_key_assignments",
    context
  );
  const resourceCount = collections.reduce((total, [, resources]) => total + resources.length, 0)
    + document.wire_bindings.length
    + document.logical_model_targets.length
    + document.model_grants.length
    + document.api_key_assignments.length;
  if (resourceCount > MAX_RESOURCES) {
    context.addIssue({ code: "custom", message: `At most ${MAX_RESOURCES} resources may be declared.` });
  }
}

function addDuplicateIssues(values: string[], path: string, context: z.RefinementCtx) {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    if (seen.has(values[index]!)) {
      context.addIssue({ code: "custom", path: [path, index], message: "Duplicate resource identity." });
    }
    seen.add(values[index]!);
  }
}

function parseGatewayBodyError(message: string) {
  return new GatewayConfigAdminError("invalid_gateway_config_document", 400, [{
    path: "document",
    message
  }]);
}
