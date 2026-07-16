import {
  gatewayProviderAttemptEvidenceSchema,
  gatewayRequestAdmissionEvidenceSchema,
  gatewayResolutionEvidenceSchema,
  type GatewayProviderAttemptEvidence,
  type GatewayRequestAdmissionEvidence,
  type GatewayResolutionEvidence
} from "@proxy/schema";

import type { GatewayExecutionTarget } from "./gatewayRuntime.js";

const requestAdmissionEvidenceKeys = gatewayRequestAdmissionEvidenceSchema.keyof().options;
const requestResolutionEvidenceKeys = gatewayResolutionEvidenceSchema.keyof().options;
const requestAdmissionEvidenceKeySet = new Set<string>(requestAdmissionEvidenceKeys);
const requestResolutionOnlyEvidenceKeys = requestResolutionEvidenceKeys.filter(
  (key) => !requestAdmissionEvidenceKeySet.has(key)
);
const providerAttemptEvidenceKeys = gatewayProviderAttemptEvidenceSchema.keyof().options;

export function validateGatewayEventEvidence(eventType: string, payload: Record<string, unknown>) {
  if (eventType === "proxy.request_received") {
    gatewayRequestEvidenceValue(payload);
  } else if (eventType === "routing.decision_recorded" || eventType === "routing.plan_recorded") {
    gatewayResolutionEvidenceValue(payload);
  } else if (
    eventType === "provider.request_started" ||
    eventType === "provider.response_completed" ||
    eventType === "provider.response_failed" ||
    eventType === "provider.response_cancelled"
  ) {
    gatewayProviderAttemptEvidenceValue(payload);
  }
}

export function gatewayRequestEvidenceValue(
  payload: Record<string, unknown>
): GatewayRequestAdmissionEvidence | GatewayResolutionEvidence | undefined {
  return gatewayEvidenceValue(payload);
}

export function gatewayResolutionEvidenceValue(
  payload: Record<string, unknown>
): GatewayRequestAdmissionEvidence | GatewayResolutionEvidence | undefined {
  return gatewayEvidenceValue(payload);
}

export function gatewayAdmissionEvidence(
  input: GatewayRequestAdmissionEvidence
): GatewayRequestAdmissionEvidence {
  return gatewayRequestAdmissionEvidenceSchema.parse(input);
}

export function gatewayResolvedEvidence(
  admission: GatewayRequestAdmissionEvidence,
  target: GatewayExecutionTarget
): GatewayResolutionEvidence {
  return gatewayResolutionEvidenceSchema.parse({
    ...admission,
    resolvedLogicalModelId: target.resolution.logicalModelId,
    accessProfileId: target.resolution.accessProfileId,
    routerKind: target.resolution.routerKind,
    deploymentId: target.resolution.deploymentId,
    providerConnectionId: target.resolution.providerConnectionId,
    egressWireId: target.resolution.egressWireId,
    wireAdapterVersion: target.resolution.wireAdapterVersion
  });
}

export function gatewayProviderAttemptEvidence(
  target: GatewayExecutionTarget
): GatewayProviderAttemptEvidence {
  return gatewayProviderAttemptEvidenceSchema.parse({
    deploymentId: target.resolution.deploymentId,
    providerConnectionId: target.resolution.providerConnectionId,
    egressWireId: target.resolution.egressWireId,
    providerAdapterContractVersion: target.resolution.providerAdapterContractVersion
  });
}

function gatewayEvidenceValue(
  payload: Record<string, unknown>
): GatewayRequestAdmissionEvidence | GatewayResolutionEvidence | undefined {
  const hasAdmissionEvidence = requestAdmissionEvidenceKeys.some((key) => Object.hasOwn(payload, key));
  const hasResolutionEvidence = requestResolutionOnlyEvidenceKeys.some((key) => Object.hasOwn(payload, key));
  if (!hasAdmissionEvidence && !hasResolutionEvidence) return undefined;

  const keys = hasResolutionEvidence ? requestResolutionEvidenceKeys : requestAdmissionEvidenceKeys;
  const schema = hasResolutionEvidence ? gatewayResolutionEvidenceSchema : gatewayRequestAdmissionEvidenceSchema;
  const result = schema.safeParse(pickPayload(payload, keys));
  if (!result.success) throw new Error("Invalid gateway resolution evidence payload.");
  return result.data;
}

export function gatewayProviderAttemptEvidenceValue(
  payload: Record<string, unknown>
): GatewayProviderAttemptEvidence | undefined {
  if (!providerAttemptEvidenceKeys.some((key) => Object.hasOwn(payload, key))) return undefined;
  const result = gatewayProviderAttemptEvidenceSchema.safeParse(pickPayload(payload, providerAttemptEvidenceKeys));
  if (!result.success) throw new Error("Invalid gateway provider-attempt evidence payload.");
  return result.data;
}

function pickPayload<const Key extends string>(payload: Record<string, unknown>, keys: readonly Key[]) {
  return Object.fromEntries(keys.flatMap((key) => (
    Object.hasOwn(payload, key) ? [[key, payload[key]]] : []
  ))) as { [Property in Key]?: unknown };
}
