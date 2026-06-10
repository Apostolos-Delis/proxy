export const apiBase = import.meta.env.VITE_PROMPT_PROXY_API_BASE ?? "http://127.0.0.1:8787";

export type AuthUser = {
  sessionId: string;
  organizationId: string;
  userId: string;
  email?: string;
  name?: string;
  role: string;
};

export type OrganizationSummary = {
  id: string;
  slug: string;
  name: string;
  role: string;
};

export type AuthMe = {
  user: AuthUser;
  organizationId: string;
  organizations: OrganizationSummary[];
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

export type RoutingConfigSnapshot = {
  configId: string;
  configName: string | null;
  versionId: string | null;
  version: number | null;
  configHash: string | null;
};

export type ClassifierSnapshot = {
  provider?: string;
  model?: string;
  attempts?: number;
  confidence?: number;
  recommendedRoute?: string;
  routingConfigId?: string;
  routingConfigVersionId?: string;
  routingConfigHash?: string;
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
  routingConfig: RoutingConfigSnapshot | null;
  classifier?: ClassifierSnapshot;
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

export type UsageLatency = {
  averageMs: number | null;
  p95Ms: number | null;
};

export type UsageGroup = {
  key: string;
  requestCount: number;
  failedRequests: number;
  retriedRequests: number;
  failureRate: number;
  retryRate: number;
  latency: UsageLatency;
  usage: Overview["totals"];
  cost: Overview["cost"];
};

export type UsageResponse = {
  groupBy: string;
  data: UsageGroup[];
  totals: UsageGroup;
};

export type UsageRangeFilters = {
  start?: string;
  end?: string;
};

export type UsageTimeseriesPoint = {
  ts: string;
  totals: UsageGroup;
  groups: Record<string, UsageGroup>;
};

export type UsageTimeseries = {
  groupBy: string;
  interval: "hour" | "day";
  start: string;
  end: string;
  groups: UsageGroup[];
  points: UsageTimeseriesPoint[];
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
  routingConfig: RoutingConfigSnapshot | null;
  classifier?: ClassifierSnapshot;
  cost: {
    selected: number;
  };
  createdAt: string;
};

export type PromptArtifactDetail = PromptSummary & {
  rawText: string | null;
  redactedText: string | null;
  encryptedBlobRef: string | null;
  metadata: Record<string, unknown>;
  expiresAt: string | null;
};

export type PromptDetail = {
  artifact: PromptArtifactDetail;
  request: RequestSummary | null;
  requestArtifacts?: PromptArtifactDetail[];
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

export type MemberRole = "owner" | "admin" | "member" | "viewer";

export type UserMembership = {
  role: string;
  status: string;
};

export type UserSummary = {
  userId: string;
  email?: string;
  name?: string;
  externalId?: string;
  membership: UserMembership | null;
  requestCount: number;
  sessionCount: number;
  usage: Overview["totals"];
  cost: Overview["cost"];
  recentActivity: string | null;
  createdAt: string;
};

export type InvitationSummary = {
  id: string;
  organizationId: string;
  email: string;
  name?: string;
  role: string;
  status: string;
  tokenPrefix: string;
  invitedBy: { userId: string; name?: string; email?: string } | null;
  acceptedUserId?: string;
  createdAt: string;
  expiresAt: string;
  lastSentAt?: string;
  acceptedAt?: string;
  revokedAt?: string;
};

export type EmailDelivery = {
  transport: string;
  delivered: boolean;
  error?: string;
};

export type InvitationActionResult = {
  invitation: InvitationSummary | null;
  inviteUrl: string;
  emailDelivery: EmailDelivery;
};

export type CreateInvitationInput = {
  email: string;
  name?: string;
  role: MemberRole;
};

export type PublicInvitation = {
  organizationName: string;
  email: string;
  name?: string;
  role: string;
  status: string;
  inviterName?: string;
  expiresAt: string;
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
  reasoningEffort?: string;
  verbosity?: string;
  routingConfig: RoutingConfigSnapshot | null;
  classifier?: ClassifierSnapshot;
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

export type EditableSettings = {
  schemaVersion: 1;
  classifier: {
    model: string;
    timeoutMs: number;
    maxAttempts: number;
    allowRedactedExcerpt: boolean;
  };
  budgets: {
    warningEstimatedInputTokens: number | null;
    maxEstimatedInputTokens: number | null;
    maxRoute: string | null;
  };
  routeQuality: {
    lowConfidenceThreshold: number;
  };
  promptCapture: {
    promptCaptureMode: string;
    retentionDays: number;
  };
};

export type Settings = {
  organizationId: string;
  databaseEnabled: boolean;
  classifier: Record<string, unknown>;
  budgets: EditableSettings["budgets"];
  promptCapture: EditableSettings["promptCapture"] | null;
  storage: {
    format: string;
    path: string;
    reason: string;
  };
  restartRequiredFor: string[];
  settings: EditableSettings;
  runtime: {
    classifier: Record<string, unknown>;
    budgets: Record<string, unknown>;
  };
  file: Record<string, unknown>;
  defaults: Record<string, unknown>;
};

export type RoutingConfigRouteMatrixRow = {
  route: string;
  description: string | null;
  openaiModel: string | null;
  openaiEffort: string | null;
  anthropicModel: string | null;
  anthropicEffort: string | null;
};

export type RoutingConfigVersionSummary = {
  id: string;
  organizationId: string;
  routingConfigId: string;
  version: number;
  configHash: string;
  status: string;
  active: boolean;
  createdByUserId: string | null;
  createdAt: string;
  activatedAt: string | null;
  archivedAt: string | null;
};

export type RoutingConfigSummary = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  activeVersionId: string | null;
  activeVersion: RoutingConfigVersionSummary | null;
  routeMatrix: RoutingConfigRouteMatrixRow[];
  systemPrompt: string | null;
  assignedApiKeyCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RoutingConfigProviderSettings = {
  model?: string;
  reasoning?: {
    effort?: string;
  };
  text?: {
    verbosity?: string;
  };
  thinking?: {
    type?: string;
    display?: string;
  };
  output_config?: {
    effort?: string;
  };
  maxOutputTokens?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
};

export type RoutingConfigDocument = {
  schemaVersion: number;
  displayName: string;
  description?: string;
  systemPrompt?: string;
  classifier: {
    provider: string;
    model: string;
    instructions: string;
    timeoutMs: number;
    maxAttempts: number;
    allowRedactedExcerpt: boolean;
    structuredOutput?: Record<string, unknown>;
  };
  routes: Record<string, {
    description?: string;
    openai?: RoutingConfigProviderSettings;
    anthropic?: RoutingConfigProviderSettings;
  }>;
  limits: Record<string, unknown>;
  session: Record<string, unknown>;
};

export type RoutingConfigVersionDetail = RoutingConfigVersionSummary & {
  config: RoutingConfigDocument;
};

export type RoutingConfigDetail = {
  config: RoutingConfigSummary;
  versions: RoutingConfigVersionDetail[];
};

export type CreateRoutingConfigInput = {
  name: string;
  slug: string;
  description: string | null;
  config: RoutingConfigDocument;
};

export type ApiKeySummary = {
  id: string;
  organizationId: string;
  userId: string | null;
  name: string;
  scopes: string[];
  routingConfigId: string | null;
  routingConfig: {
    id: string;
    name: string | null;
    status: string | null;
  } | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type SearchHitKind = "session" | "log" | "user" | "routing_config" | "api_key";

export type SearchHit = {
  kind: SearchHitKind;
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  snippet: string | null;
  occurredAt: string | null;
};

export type SearchResponse = {
  query: string;
  results: SearchHit[];
};

export async function fetchGlobalSearch(query: string) {
  return fetchJson<SearchResponse>(`/admin/search?q=${encodeURIComponent(query)}`);
}

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

export async function updateSettings(settings: EditableSettings) {
  return fetchJson<Settings>("/admin/settings", {
    method: "PATCH",
    body: JSON.stringify(settings)
  });
}

export async function fetchApiKeys() {
  return fetchJson<{ data: ApiKeySummary[] }>("/admin/api-keys");
}

export async function fetchRoutingConfigs() {
  return fetchJson<{ data: RoutingConfigSummary[] }>("/admin/routing-configs");
}

export async function fetchRoutingConfigDetail(configId: string) {
  return fetchJson<RoutingConfigDetail>(`/admin/routing-configs/${encodeURIComponent(configId)}`);
}

export async function createRoutingConfig(input: CreateRoutingConfigInput) {
  return fetchJson<RoutingConfigDetail>("/admin/routing-configs", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function createRoutingConfigVersion(configId: string, config: RoutingConfigDocument) {
  return fetchJson<RoutingConfigDetail>(
    `/admin/routing-configs/${encodeURIComponent(configId)}/versions`,
    {
      method: "POST",
      body: JSON.stringify({ config })
    }
  );
}

export async function activateRoutingConfigVersion(configId: string, versionId: string) {
  return fetchJson<RoutingConfigDetail>(
    `/admin/routing-configs/${encodeURIComponent(configId)}/versions/${encodeURIComponent(versionId)}/activate`,
    { method: "POST" }
  );
}

export async function archiveRoutingConfig(configId: string) {
  return fetchJson<RoutingConfigDetail>(
    `/admin/routing-configs/${encodeURIComponent(configId)}/archive`,
    { method: "POST" }
  );
}

export async function assignApiKeyRoutingConfig(apiKeyId: string, routingConfigId: string | null) {
  return fetchJson<{ apiKey: ApiKeySummary }>(
    `/admin/api-keys/${encodeURIComponent(apiKeyId)}/routing-config`,
    {
      method: "PATCH",
      body: JSON.stringify({ routingConfigId })
    }
  );
}

export type CreateApiKeyInput = {
  name: string;
  scopes: string[];
  routingConfigId: string | null;
};

export type CreatedApiKey = {
  apiKey: ApiKeySummary | null;
  secret: string;
};

export async function createApiKey(input: CreateApiKeyInput) {
  return fetchJson<CreatedApiKey>("/admin/api-keys", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function revokeApiKey(apiKeyId: string) {
  return fetchJson<{ apiKey: ApiKeySummary }>(
    `/admin/api-keys/${encodeURIComponent(apiKeyId)}/revoke`,
    { method: "POST" }
  );
}

export async function fetchUsage(groupBy: string, filters: UsageRangeFilters = {}) {
  return fetchJson<UsageResponse>(`/admin/usage?${usageParams(groupBy, filters)}`);
}

export async function fetchUsageTimeseries(
  groupBy: string,
  filters: UsageRangeFilters & { interval?: "hour" | "day"; limit?: number } = {}
) {
  const params = usageParams(groupBy, filters);
  if (filters.interval) params.set("interval", filters.interval);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  return fetchJson<UsageTimeseries>(`/admin/usage/timeseries?${params}`);
}

function usageParams(groupBy: string, filters: UsageRangeFilters) {
  const params = new URLSearchParams({ groupBy });
  if (filters.start) params.set("start", filters.start);
  if (filters.end) params.set("end", filters.end);
  return params;
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

export async function fetchInvitations() {
  return fetchJson<{ data: InvitationSummary[] }>("/admin/invitations");
}

export async function createInvitation(input: CreateInvitationInput) {
  return fetchJson<InvitationActionResult>("/admin/invitations", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function resendInvitation(invitationId: string) {
  return fetchJson<InvitationActionResult>(
    `/admin/invitations/${encodeURIComponent(invitationId)}/resend`,
    { method: "POST" }
  );
}

export async function revokeInvitation(invitationId: string) {
  return fetchJson<{ invitation: InvitationSummary }>(
    `/admin/invitations/${encodeURIComponent(invitationId)}/revoke`,
    { method: "POST" }
  );
}

export async function updateUserRole(userId: string, role: MemberRole) {
  return fetchJson<{ userId: string; role: string; previousRole: string }>(
    `/admin/users/${encodeURIComponent(userId)}/role`,
    {
      method: "PATCH",
      body: JSON.stringify({ role })
    }
  );
}

export async function deactivateUser(userId: string) {
  return fetchJson<{ userId: string; status: string }>(
    `/admin/users/${encodeURIComponent(userId)}/deactivate`,
    { method: "POST" }
  );
}

export async function reactivateUser(userId: string) {
  return fetchJson<{ userId: string; status: string }>(
    `/admin/users/${encodeURIComponent(userId)}/reactivate`,
    { method: "POST" }
  );
}

export async function resolveInvitation(token: string) {
  return fetchJson<{ invitation: PublicInvitation }>("/api/invitations/resolve", {
    method: "POST",
    body: JSON.stringify({ token })
  });
}

export async function acceptInvitation(token: string, name?: string) {
  return fetchJson<{ ok: boolean; organizationId: string; userId: string; email: string; role: string }>(
    "/api/invitations/accept",
    {
      method: "POST",
      body: JSON.stringify(name ? { token, name } : { token })
    }
  );
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

export async function switchOrganization(organizationId: string) {
  return fetchJson<AuthMe>("/api/auth/switch-organization", {
    method: "POST",
    body: JSON.stringify({ organizationId })
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
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers
    }
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

async function responseErrorMessage(response: Response) {
  const fallback = `${response.status} ${response.statusText}`;
  const body = await response.json().catch(() => null) as {
    error?: unknown;
    issues?: { path?: unknown; message?: unknown }[];
  } | null;
  if (typeof body?.error !== "string") return fallback;

  const issues = Array.isArray(body.issues)
    ? body.issues
      .map((issue) => {
        if (typeof issue.message !== "string") return null;
        const path = typeof issue.path === "string" ? `${issue.path}: ` : "";
        return `${path}${issue.message}`;
      })
      .filter((issue): issue is string => Boolean(issue))
    : [];
  return issues.length > 0 ? `${body.error} (${issues.join("; ")})` : body.error;
}
