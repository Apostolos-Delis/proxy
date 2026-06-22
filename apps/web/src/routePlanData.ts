import type { PromptDetailResult } from "./promptDetailData";

export { routeSkipReasonLabel as formatSkipReason } from "./routeSkipReasons";

export type RouteDecisionEvidence = PromptDetailResult["routeDecisions"][number];
export type ProviderAttemptEvidence = PromptDetailResult["providerAttempts"][number];

export type RoutePlanCandidate = {
  id: string;
  order: number;
  providerId: string;
  model: string;
  endpointDialect: string;
  translated: boolean;
  translatorId: string | null;
  compatible: boolean;
  eligible: boolean;
  skipReasons: string[];
  factors: Record<string, unknown>;
};

export type RoutePlanEvidence = {
  schemaVersion: number;
  classifier: {
    provider?: string;
    model?: string;
    route?: string;
    confidence?: number | null;
  };
  routingConfig: {
    id?: string;
    versionId?: string;
    version?: number;
    hash?: string;
  };
  candidates: RoutePlanCandidate[];
  selected: {
    candidateId: string;
    providerId?: string;
    providerAccountId?: string | null;
    model?: string;
    dialect?: string;
    translated?: boolean;
  } | null;
  policyResults: unknown[];
};

export function routePlanFromDecision(decision: RouteDecisionEvidence | undefined): RoutePlanEvidence | null {
  const raw = decision?.routeExecutionPlan;
  if (!isRecord(raw)) return null;
  const schemaVersion = numberValue(raw.schemaVersion);
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.map(candidateFrom).filter((candidate): candidate is RoutePlanCandidate => candidate !== null)
    : [];
  if (!schemaVersion || candidates.length === 0) return null;
  return {
    schemaVersion,
    classifier: classifierFrom(raw.classifier),
    routingConfig: routingConfigFrom(raw.routingConfig),
    candidates,
    selected: selectedFrom(raw.selected),
    policyResults: Array.isArray(raw.policyResults) ? raw.policyResults : []
  };
}

export function decisionWithPlan(decisions: RouteDecisionEvidence[]) {
  return decisions.find((decision) => routePlanFromDecision(decision) !== null) ?? decisions[0];
}

export function attemptsForCandidate(attempts: ProviderAttemptEvidence[], candidateId: string) {
  return attempts.filter((attempt) => attempt.routeCandidateId === candidateId);
}

function candidateFrom(value: unknown): RoutePlanCandidate | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const providerId = stringValue(value.providerId);
  const model = stringValue(value.model);
  const endpointDialect = stringValue(value.endpointDialect);
  if (!id || !providerId || !model || !endpointDialect) return null;
  return {
    id,
    order: numberValue(value.order) ?? 0,
    providerId,
    model,
    endpointDialect,
    translated: booleanValue(value.translated) ?? false,
    translatorId: stringValue(value.translatorId) ?? null,
    compatible: booleanValue(value.compatible) ?? false,
    eligible: booleanValue(value.eligible) ?? false,
    skipReasons: stringArray(value.skipReasons),
    factors: isRecord(value.factors) ? value.factors : {}
  };
}

function selectedFrom(value: unknown): RoutePlanEvidence["selected"] {
  if (!isRecord(value)) return null;
  const candidateId = stringValue(value.candidateId);
  if (!candidateId) return null;
  return {
    candidateId,
    providerId: stringValue(value.providerId),
    providerAccountId: stringValue(value.providerAccountId) ?? null,
    model: stringValue(value.model),
    dialect: stringValue(value.dialect),
    translated: booleanValue(value.translated)
  };
}

function classifierFrom(value: unknown): RoutePlanEvidence["classifier"] {
  if (!isRecord(value)) return {};
  return {
    provider: stringValue(value.provider),
    model: stringValue(value.model),
    route: stringValue(value.route),
    confidence: numberValue(value.confidence) ?? null
  };
}

function routingConfigFrom(value: unknown): RoutePlanEvidence["routingConfig"] {
  if (!isRecord(value)) return {};
  return {
    id: stringValue(value.id),
    versionId: stringValue(value.versionId),
    version: numberValue(value.version),
    hash: stringValue(value.hash)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
