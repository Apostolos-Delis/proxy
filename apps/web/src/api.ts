const apiBase = import.meta.env.VITE_PROMPT_PROXY_API_BASE ?? "http://127.0.0.1:8787";
const apiToken = import.meta.env.VITE_PROMPT_PROXY_TOKEN ?? "dev-proxy-token";

export type Overview = {
  organizationId: string;
  eventCount: number;
  requestCount: number;
  totals: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  cost: {
    selected: number;
    baseline: number;
    savings: number;
  };
  routeQuality: {
    lowConfidenceCount: number;
    cheaperLikelyWouldWorkCount: number;
    cheapCausedRetriesOrRepairsCount: number;
  };
};

export type RequestSummary = {
  requestId: string;
  surface?: string;
  requestedModel?: string;
  finalRoute?: string;
  selectedModel?: string;
  terminalStatus: string;
  inputChars?: number;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  };
  latencyMs?: number;
  timeToFirstByteMs?: number;
  selectedCost: number;
  baselineCost: number;
  savings: number;
};

export type ProxyEvent = {
  eventId: string;
  sequence: number;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  correlationId?: string;
  eventType: string;
  producer: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RequestDetail = {
  request: RequestSummary | null;
  events: ProxyEvent[];
};

export type Settings = {
  organizationId: string;
  databaseEnabled: boolean;
  classifier: Record<string, unknown>;
  budgets: Record<string, unknown>;
  routePolicyTrust: Record<string, unknown>;
};

export async function fetchOverview() {
  return fetchJson<Overview>("/admin/overview");
}

export async function fetchRequests() {
  return fetchJson<{ data: RequestSummary[] }>("/admin/requests");
}

export async function fetchRequestDetail(requestId: string) {
  return fetchJson<RequestDetail>(`/admin/requests/${encodeURIComponent(requestId)}`);
}

export async function fetchSettings() {
  return fetchJson<Settings>("/admin/settings");
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      authorization: `Bearer ${apiToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
