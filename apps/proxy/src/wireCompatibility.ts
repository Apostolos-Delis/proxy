import {
  harnessCompatibilityForTarget,
  type Dialect,
  type GatewayOperationId,
  type HarnessCompatibilityProfileId,
  type TranslationCompatibilityReason
} from "@proxy/schema";

import { translators } from "./translators/index.js";
import { wirePathSupportsOperation } from "./wireContracts.js";

export type WireCompatibilityInput = {
  ingressWireId: Dialect;
  operationId: GatewayOperationId;
  targetWireIds: readonly Dialect[];
  harnessProfileId?: HarnessCompatibilityProfileId;
  transport?: "http" | "websocket";
  statefulResponses?: boolean;
  hasPreviousResponseId?: boolean;
  unsupportedFields?: readonly string[];
};

export type WireCompatibilityResult =
  | {
      outcome: "compatible";
      egressWireId: Dialect;
      wireAdapterId: string | null;
      wireAdapterVersion: string | null;
    }
  | {
      outcome: "unsupported";
      reason: TranslationCompatibilityReason | "operation_unavailable";
    };

export function resolveWireCompatibility(input: WireCompatibilityInput): WireCompatibilityResult {
  const operationWires = [...new Set(input.targetWireIds)]
    .filter((wireId) => wirePathSupportsOperation(input.ingressWireId, wireId, input.operationId));
  if (operationWires.length === 0) {
    return { outcome: "unsupported", reason: "operation_unavailable" };
  }

  const compatibility = harnessCompatibilityForTarget({
    profileId: input.harnessProfileId ?? defaultProfileId(input.ingressWireId),
    surface: input.ingressWireId,
    transport: input.transport ?? "http",
    statefulResponses: input.statefulResponses,
    hasPreviousResponseId: input.hasPreviousResponseId,
    unsupportedFields: input.unsupportedFields,
    targetDialects: operationWires,
    availableTranslators: translators.availablePairs()
  });
  if (compatibility.status === "unavailable" || !compatibility.dialect) {
    return {
      outcome: "unsupported",
      reason: compatibility.reason ?? "dialect_unavailable"
    };
  }

  const adapter = translators.adapterContract(input.ingressWireId, compatibility.dialect);
  if (adapter === undefined) {
    return { outcome: "unsupported", reason: "translator_unavailable" };
  }
  return {
    outcome: "compatible",
    egressWireId: compatibility.dialect,
    wireAdapterId: adapter?.id ?? null,
    wireAdapterVersion: adapter?.version ?? null
  };
}

function defaultProfileId(wireId: Dialect): HarnessCompatibilityProfileId {
  if (wireId === "anthropic-messages") return "generic-anthropic-messages";
  if (wireId === "openai-responses") return "generic-openai-responses";
  return "openai-chat-sdk";
}
