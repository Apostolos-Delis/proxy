import { eq } from "drizzle-orm";

import { routeDecisions, type PromptProxyTransaction } from "@prompt-proxy/db";

import { createId } from "../util.js";
import {
  basisPoints,
  providerValue,
  recordArray,
  recordValue,
  routeValue,
  routingConfigSnapshotValue,
  stringArray,
  stringValue
} from "./values.js";

export async function persistRouteDecision(tx: PromptProxyTransaction, event: {
  tenantId: string;
  scopeId: string;
  payload: Record<string, unknown>;
}) {
  const payload = event.payload;
  const classifier = recordValue(payload.classifier) ?? {};
  const routingConfig = routingConfigSnapshotValue(payload.routingConfig);
  await tx
    .insert(routeDecisions)
    .values({
      id: createId("route_decision"),
      requestId: event.scopeId,
      organizationId: event.tenantId,
      requestedModel: stringValue(payload.requestedModel) ?? "unknown",
      classifierRoute: routeValue(payload.classifierRoute),
      finalRoute: routeValue(payload.finalRoute),
      selectedProvider: providerValue(payload.provider),
      selectedModel: stringValue(payload.selectedModel),
      reasoningEffort: stringValue(payload.reasoningEffort),
      verbosity: stringValue(payload.verbosity),
      routingConfigId: routingConfig?.configId,
      routingConfigVersionId: routingConfig?.versionId,
      routingConfigVersion: routingConfig?.version,
      routingConfigHash: routingConfig?.configHash,
      confidence: basisPoints(recordValue(payload.classifier)?.confidence),
      reasonCodes: stringArray(payload.reasonCodes),
      guardrailActions: stringArray(payload.guardrailActions),
      budgetChecks: recordArray(payload.budgetChecks),
      classifier,
      policyVersion: stringValue(payload.policyVersion) ?? "unknown"
    })
    .onConflictDoUpdate({
      target: routeDecisions.requestId,
      set: {
        classifierRoute: routeValue(payload.classifierRoute),
        finalRoute: routeValue(payload.finalRoute),
        selectedProvider: providerValue(payload.provider),
        selectedModel: stringValue(payload.selectedModel),
        reasoningEffort: stringValue(payload.reasoningEffort),
        verbosity: stringValue(payload.verbosity),
        routingConfigId: routingConfig?.configId,
        routingConfigVersionId: routingConfig?.versionId,
        routingConfigVersion: routingConfig?.version,
        routingConfigHash: routingConfig?.configHash,
        confidence: basisPoints(recordValue(payload.classifier)?.confidence),
        reasonCodes: stringArray(payload.reasonCodes),
        guardrailActions: stringArray(payload.guardrailActions),
        budgetChecks: recordArray(payload.budgetChecks),
        classifier
      }
    });
}

export async function routeForRequest(tx: PromptProxyTransaction, requestId: string) {
  const [decision] = await tx
    .select()
    .from(routeDecisions)
    .where(eq(routeDecisions.requestId, requestId))
    .limit(1);
  return decision?.finalRoute ?? undefined;
}
