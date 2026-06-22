import { eq } from "drizzle-orm";

import { defaultWorkspaceId, routeDecisions, type PromptProxyTransaction } from "@prompt-proxy/db";

import { createId } from "../util.js";
import {
  basisPoints,
  booleanValue,
  providerValue,
  recordArray,
  recordValue,
  routeValue,
  routeExecutionPlanValue,
  routingConfigSnapshotValue,
  stringArray,
  stringValue
} from "./values.js";

export async function persistRouteDecision(tx: PromptProxyTransaction, event: {
  tenantId: string;
  workspaceId?: string;
  scopeId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  const payload = event.payload;
  const classifier = recordValue(payload.classifier) ?? {};
  const routingConfig = routingConfigSnapshotValue(payload.routingConfig);
  const routeExecutionPlan = routeExecutionPlanValue(payload.routeExecutionPlan ?? payload.plan);
  if (event.eventType === "routing.plan_recorded" && !routeExecutionPlan) {
    throw new Error("Route execution plan event is missing routeExecutionPlan.");
  }
  const planRoutingConfig = routeExecutionPlan?.routingConfig;
  const selectedCandidateId = stringValue(payload.selectedCandidateId) ?? routeExecutionPlan?.selected?.candidateId;
  const selectedCandidate = selectedCandidateId
    ? routeExecutionPlan?.candidates.find((candidate) => candidate.id === selectedCandidateId)
    : undefined;
  const translated = booleanValue(payload.translated) ?? routeExecutionPlan?.selected?.translated;
  const translatorId = stringValue(payload.translatorId) ?? selectedCandidate?.translatorId;
  const selectedProvider = providerValue(payload.provider) ?? routeExecutionPlan?.selected?.providerId;
  const selectedModel = stringValue(payload.selectedModel) ?? routeExecutionPlan?.selected?.model;
  const classifierRoute = routeValue(payload.classifierRoute) ?? routeExecutionPlan?.classifier.route;
  const finalRoute = routeValue(payload.finalRoute) ?? routeExecutionPlan?.classifier.route;
  const routingConfigId = routingConfig?.configId ?? planRoutingConfig?.id;
  const routingConfigVersionId = routingConfig?.versionId ?? planRoutingConfig?.versionId;
  const routingConfigVersion = routingConfig?.version ?? planRoutingConfig?.version;
  const routingConfigHash = routingConfig?.configHash ?? planRoutingConfig?.hash;
  const updateValues: Partial<typeof routeDecisions.$inferInsert> = event.eventType === "routing.plan_recorded"
    ? {}
    : {
        classifierRoute,
        finalRoute,
        selectedProvider,
        selectedModel,
        reasoningEffort: stringValue(payload.reasoningEffort),
        verbosity: stringValue(payload.verbosity),
        routingConfigId,
        routingConfigVersionId,
        routingConfigVersion,
        routingConfigHash,
        confidence: basisPoints(recordValue(payload.classifier)?.confidence),
        reasonCodes: stringArray(payload.reasonCodes),
        guardrailActions: stringArray(payload.guardrailActions),
        budgetChecks: recordArray(payload.budgetChecks),
        classifier
      };
  if (event.eventType === "routing.plan_recorded") {
    if (classifierRoute !== undefined) updateValues.classifierRoute = classifierRoute;
    if (finalRoute !== undefined) updateValues.finalRoute = finalRoute;
    if (selectedProvider !== undefined) updateValues.selectedProvider = selectedProvider;
    if (selectedModel !== undefined) updateValues.selectedModel = selectedModel;
    if (routingConfigId !== undefined) updateValues.routingConfigId = routingConfigId;
    if (routingConfigVersionId !== undefined) updateValues.routingConfigVersionId = routingConfigVersionId;
    if (routingConfigVersion !== undefined) updateValues.routingConfigVersion = routingConfigVersion;
    if (routingConfigHash !== undefined) updateValues.routingConfigHash = routingConfigHash;
  }
  if (routeExecutionPlan) updateValues.routeExecutionPlan = routeExecutionPlan;
  if (selectedCandidateId) updateValues.selectedCandidateId = selectedCandidateId;
  if (translated !== undefined) updateValues.translated = translated;
  if (translatorId !== undefined) updateValues.translatorId = translatorId;
  await tx
    .insert(routeDecisions)
    .values({
      id: createId("route_decision"),
      requestId: event.scopeId,
      organizationId: event.tenantId,
      workspaceId: event.workspaceId ?? defaultWorkspaceId(event.tenantId),
      requestedModel: stringValue(payload.requestedModel) ?? "unknown",
      classifierRoute,
      finalRoute,
      selectedProvider,
      selectedModel,
      reasoningEffort: stringValue(payload.reasoningEffort),
      verbosity: stringValue(payload.verbosity),
      routingConfigId,
      routingConfigVersionId,
      routingConfigVersion,
      routingConfigHash,
      confidence: basisPoints(recordValue(payload.classifier)?.confidence),
      reasonCodes: stringArray(payload.reasonCodes),
      guardrailActions: stringArray(payload.guardrailActions),
      budgetChecks: recordArray(payload.budgetChecks),
      classifier,
      routeExecutionPlan: routeExecutionPlan ?? {},
      selectedCandidateId,
      translated: translated ?? false,
      translatorId,
      policyVersion: stringValue(payload.policyVersion) ?? "unknown"
    })
    .onConflictDoUpdate({
      target: routeDecisions.requestId,
      set: updateValues
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
