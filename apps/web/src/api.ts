const apiBase = import.meta.env.VITE_PROMPT_PROXY_API_BASE ?? "http://127.0.0.1:8787";

export type AuthUser = {
  sessionId: string;
  organizationId: string;
  userId: string;
  email?: string;
  name?: string;
  role: string;
};

export type AuthMe = {
  user: AuthUser;
  organizationId: string;
};

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
  userId?: string;
  sessionId?: string;
  surface?: string;
  requestedModel?: string;
  finalRoute?: string;
  provider?: string;
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
  attemptCount?: number;
  createdAt?: string;
  completedAt?: string;
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

export type UsageGroup = {
  key: string;
  requestCount: number;
  failedRequests: number;
  retriedRequests: number;
  failureRate: number;
  retryRate: number;
  usage: Overview["totals"];
  cost: Overview["cost"];
};

export type UsageResponse = {
  groupBy: string;
  data: UsageGroup[];
  totals: UsageGroup;
};

export type PromptSummary = {
  artifactId: string;
  organizationId: string;
  requestId: string;
  sessionId?: string;
  userId?: string;
  surface: string;
  kind: string;
  storageMode: string;
  contentHash: string;
  sourceRole?: string;
  sourceIndex?: number;
  chars?: number;
  tokenEstimate?: number;
  preview: string | null;
  finalRoute?: string;
  provider?: string;
  selectedModel?: string;
  cost: {
    selected: number;
  };
  createdAt: string;
};

export type PromptDetail = {
  artifact: PromptSummary & {
    rawText: string | null;
    redactedText: string | null;
    encryptedBlobRef: string | null;
    metadata: Record<string, unknown>;
    expiresAt: string | null;
  };
  request: RequestSummary | null;
  events: ProxyEvent[];
};

export type SessionSummary = {
  sessionId: string;
  organizationId: string;
  userId?: string;
  surface: string;
  externalSessionId?: string;
  currentRoute?: string;
  sessionIdentity?: string;
  requestCount: number;
  routeChanges: number;
  modelMix: Record<string, number>;
  routeMix: Record<string, number>;
  terminalStatusSummary: Record<string, number>;
  usage: Overview["totals"];
  cost: Overview["cost"];
  recentActivity: string | null;
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
};

export type UserSummary = {
  userId: string;
  email?: string;
  name?: string;
  externalId?: string;
  requestCount: number;
  sessionCount: number;
  usage: Overview["totals"];
  cost: Overview["cost"];
  recentActivity: string | null;
  createdAt: string;
};

export type ProviderAttempt = {
  id: string;
  requestId: string;
  surface: string;
  provider: string;
  model: string;
  terminalStatus: string;
  statusCode?: number;
  error?: string;
  startedAt: string;
  firstByteAt?: string;
  completedAt?: string;
};

export type UsageLedgerRow = {
  id: string;
  requestId: string;
  providerAttemptId: string;
  provider: string;
  model: string;
  route?: string;
  totalTokens: number;
  totalCostMicros: number;
  createdAt: string;
};

export type RouteDecision = {
  id: string;
  requestId: string;
  requestedModel: string;
  classifierRoute?: string;
  finalRoute?: string;
  selectedProvider?: string;
  selectedModel?: string;
  confidence: number | null;
  reasonCodes: string[];
  createdAt: string;
};

export type SessionDetail = {
  session: SessionSummary;
  user: Record<string, unknown> | null;
  requests: RequestSummary[];
  promptArtifacts: PromptDetail["artifact"][];
  routeDecisions: RouteDecision[];
  providerAttempts: ProviderAttempt[];
  usageLedger: UsageLedgerRow[];
  events: ProxyEvent[];
};

export type Settings = {
  organizationId: string;
  databaseEnabled: boolean;
  classifier: Record<string, unknown>;
  budgets: Record<string, unknown>;
  promptCapture: {
    promptCaptureMode: string;
    retentionDays: number;
  } | null;
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

export async function fetchUsage(groupBy: string) {
  return fetchJson<UsageResponse>(`/admin/usage?groupBy=${encodeURIComponent(groupBy)}`);
}

export async function fetchPrompts() {
  return fetchJson<{ data: PromptSummary[]; pagination: { limit: number; offset: number; count: number } }>("/admin/prompts");
}

export async function fetchPromptDetail(artifactId: string) {
  return fetchJson<PromptDetail>(`/admin/prompts/${encodeURIComponent(artifactId)}`);
}

export async function fetchSessions() {
  return fetchJson<{ data: SessionSummary[] }>("/admin/sessions");
}

export async function fetchSessionDetail(sessionId: string) {
  return fetchJson<SessionDetail>(`/admin/sessions/${encodeURIComponent(sessionId)}`);
}

export async function fetchUsers() {
  return fetchJson<{ data: UserSummary[] }>("/admin/users");
}

export async function fetchMe() {
  return fetchJson<AuthMe>("/api/auth/me");
}

export async function login(email: string, password: string) {
  return fetchJson<AuthMe>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export async function logout() {
  return fetchJson<{ ok: boolean }>("/api/auth/logout", {
    method: "POST"
  });
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
