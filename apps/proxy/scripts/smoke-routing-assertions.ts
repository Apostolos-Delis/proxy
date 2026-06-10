export type SmokeRequestSummary = {
  surface: string;
  finalRoute?: string;
  selectedModel?: string;
  routingConfig: {
    configId: string;
    versionId: string | null;
    version: number | null;
    configHash: string | null;
  } | null;
};

export type SmokeRequestAssertion = {
  label: string;
  surface: string;
  finalRoute: string;
  selectedModel: string;
  routingConfigId: string;
};

export async function assertPersistedRoutingDecision(
  adminQueries: { requests: () => Promise<{ data: SmokeRequestSummary[] }> },
  expected: SmokeRequestAssertion
) {
  const requests = await adminQueries.requests();
  const match = requests.data.find((request) =>
    request.surface === expected.surface &&
    request.selectedModel === expected.selectedModel &&
    request.finalRoute === expected.finalRoute
  );
  if (!match) {
    throw new Error(
      `config resolution failed: ${expected.label} did not persist a ${expected.finalRoute} route decision. requests=${summarizeSmokeRequests(requests.data)}`
    );
  }
  if (match.routingConfig?.configId !== expected.routingConfigId) {
    throw new Error(
      `config resolution failed: ${expected.label} used config=${match.routingConfig?.configId ?? "null"} expected=${expected.routingConfigId}. requests=${summarizeSmokeRequests(requests.data)}`
    );
  }
  if (!match.routingConfig.versionId || !match.routingConfig.version || !match.routingConfig.configHash) {
    throw new Error(
      `config resolution failed: ${expected.label} persisted an incomplete routing config snapshot. request=${JSON.stringify(match)}`
    );
  }
}

function summarizeSmokeRequests(requests: SmokeRequestSummary[]) {
  return JSON.stringify(requests.map((request) => ({
    surface: request.surface,
    finalRoute: request.finalRoute,
    selectedModel: request.selectedModel,
    routingConfigId: request.routingConfig?.configId ?? null,
    routingConfigVersionId: request.routingConfig?.versionId ?? null
  })));
}
