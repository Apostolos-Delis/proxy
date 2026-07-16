import { and, eq } from "drizzle-orm";

import { defaultWorkspaceId, requests, routeDecisions, type ProxyTransaction } from "@proxy/db";

import { gatewayResolutionEvidenceValue } from "../gatewayEvidence.js";
import { createId } from "../util.js";
import {
  basisPoints,
  booleanValue,
  providerValue,
  recordValue,
  stringArray,
  stringValue
} from "./values.js";

export async function persistRouteDecision(tx: ProxyTransaction, event: {
  tenantId: string;
  workspaceId?: string;
  scopeId: string;
  payload: Record<string, unknown>;
}) {
  const payload = event.payload;
  const workspaceId = event.workspaceId ?? defaultWorkspaceId(event.tenantId);
  const gatewayEvidence = gatewayResolutionEvidenceValue(payload);
  const routerDecision = recordValue(payload.routerDecision) ?? {};
  const values = {
    requestedModel: stringValue(payload.requestedModel) ?? "unknown",
    selectedProvider: providerValue(payload.provider),
    selectedModel: stringValue(payload.selectedModel),
    reasoningEffort: stringValue(payload.reasoningEffort),
    verbosity: stringValue(payload.verbosity),
    ...gatewayEvidence,
    confidence: basisPoints(routerDecision.confidence),
    reasonCodes: stringArray(payload.reasonCodes),
    guardrailActions: stringArray(payload.guardrailActions),
    routerDecisionId: stringValue(payload.routerDecisionId),
    routerDecision,
    translated: booleanValue(payload.translated) ?? false,
    translatorId: stringValue(payload.translatorId),
    policyVersion: stringValue(payload.policyVersion) ?? "unknown"
  };
  await tx
    .insert(routeDecisions)
    .values({
      id: createId("route_decision"),
      requestId: event.scopeId,
      organizationId: event.tenantId,
      workspaceId,
      ...values
    })
    .onConflictDoUpdate({ target: routeDecisions.requestId, set: values });

  if (gatewayEvidence) {
    await tx
      .update(requests)
      .set(gatewayEvidence)
      .where(and(
        eq(requests.id, event.scopeId),
        eq(requests.organizationId, event.tenantId),
        eq(requests.workspaceId, workspaceId)
      ));
  }
}
