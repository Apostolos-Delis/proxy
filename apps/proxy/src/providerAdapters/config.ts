import { z } from "zod";

import type { ProviderAdapterKind } from "@proxy/schema";

export const providerRegionSchema = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/);

const providerAdapterConfigSchemas = {
  "generic-http-json": z.strictObject({}),
  "aws-bedrock-converse": z.strictObject({
    service: z.literal("bedrock-runtime").optional(),
    controlPlaneService: z.literal("bedrock").optional(),
    defaultRegion: providerRegionSchema.refine(
      (value) => value === value.trim(),
      "Region must not include surrounding whitespace."
    ).optional(),
    credentialMode: z.enum([
      "aws_bedrock_bearer_token",
      "aws_static_keys",
      "aws_default_chain",
      "aws_profile"
    ]).optional(),
    region: providerRegionSchema.optional(),
    discoveryRegions: z.array(providerRegionSchema).max(32).optional(),
    endpointOverride: z.string().url().max(2_048).optional(),
    supportsBearerToken: z.boolean().optional(),
    supportsInferenceProfiles: z.boolean().optional()
  })
} satisfies Record<ProviderAdapterKind, z.ZodType>;

export function isProviderAdapterConfigValid(
  adapterKind: ProviderAdapterKind,
  adapterConfig: Record<string, unknown>
) {
  return providerAdapterConfigSchemas[adapterKind].safeParse(adapterConfig).success;
}
