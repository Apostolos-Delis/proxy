export type SmokeRequestSummary = {
  surface: string;
  requestedLogicalModel?: string;
  resolvedLogicalModelId?: string;
  accessProfileId?: string;
  selectedModel?: string;
  deploymentId?: string;
  providerConnectionId?: string;
  ingressWireId?: string;
  egressWireId?: string;
};

export type SmokeRequestAssertion = {
  label: string;
  surface: string;
  requestedLogicalModel: string;
  resolvedLogicalModelId: string;
  accessProfileId: string;
  selectedModel: string;
  deploymentId: string;
  providerConnectionId: string;
  ingressWireId: string;
  egressWireId: string;
};

export async function assertPersistedGatewayResolution(
  adminQueries: { requests: () => Promise<{ data: SmokeRequestSummary[] }> },
  expected: SmokeRequestAssertion
) {
  const requests = await adminQueries.requests();
  const match = requests.data.find((request) =>
    request.surface === expected.surface &&
    request.requestedLogicalModel === expected.requestedLogicalModel &&
    request.selectedModel === expected.selectedModel
  );
  if (!match) {
    throw new Error(
      `gateway resolution failed: ${expected.label} was not persisted. requests=${summarizeSmokeRequests(requests.data)}`
    );
  }

  for (const field of [
    "resolvedLogicalModelId",
    "accessProfileId",
    "deploymentId",
    "providerConnectionId",
    "ingressWireId",
    "egressWireId"
  ] as const) {
    if (match[field] !== expected[field]) {
      throw new Error(
        `gateway resolution failed: ${expected.label} persisted ${field}=${match[field] ?? "null"} expected=${expected[field]}. request=${JSON.stringify(match)}`
      );
    }
  }
}

function summarizeSmokeRequests(requests: SmokeRequestSummary[]) {
  return JSON.stringify(requests.map((request) => ({
    surface: request.surface,
    requestedLogicalModel: request.requestedLogicalModel,
    resolvedLogicalModelId: request.resolvedLogicalModelId,
    selectedModel: request.selectedModel,
    deploymentId: request.deploymentId,
    providerConnectionId: request.providerConnectionId,
    ingressWireId: request.ingressWireId,
    egressWireId: request.egressWireId
  })));
}
