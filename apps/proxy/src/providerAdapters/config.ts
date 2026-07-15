import { z } from "zod";

import type { ProviderAdapterKind } from "@proxy/schema";

const providerAdapterConfigSchemas = {
  "generic-http-json": z.strictObject({}),
  "aws-bedrock-converse": z.strictObject({
    service: z.literal("bedrock-runtime").optional(),
    controlPlaneService: z.literal("bedrock").optional(),
    defaultRegion: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).refine(
      (value) => value === value.trim(),
      "Region must not include surrounding whitespace."
    ).optional(),
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
