import type { RoutingConfig } from "@prompt-proxy/schema";

export type Surface = "openai-responses" | "anthropic-messages";

export type Provider = "openai" | "anthropic";

export type RouteName = "fast" | "balanced" | "hard" | "deep";

export type ReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type Verbosity = "low" | "medium" | "high";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type ModelCatalogEntry = {
  readonly id: string;
  readonly provider: Provider;
  readonly upstreamModel: string;
  readonly supportsResponses: boolean;
  readonly supportsMessages: boolean;
  readonly supportsTools: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsReasoning: boolean;
  readonly supportedReasoningEfforts: readonly ReasoningEffort[];
  readonly supportsVerbosity: boolean;
  readonly contextWindow: number;
  readonly inputCostPerMtok: number;
  readonly outputCostPerMtok: number;
};

export type RouteConfig = {
  name: RouteName;
  openaiModel: string;
  anthropicModel: string;
  reasoningEffort: ReasoningEffort;
  verbosity: Verbosity;
};

export type RouteContext = {
  organizationId?: string;
  surface: Surface;
  requestedModel: string;
  inputChars: number;
  inputHash: string;
  estimatedInputTokens: number;
  routingInputSource: "latest_user_message" | "full_request";
  routingInputText: string;
  routingInputChars: number;
  routingInputHash: string;
  routingEstimatedInputTokens: number;
  hasTools: boolean;
  toolCount: number;
  hasPreviousResponseId: boolean;
  hasImages: boolean;
  extractedHints: string[];
  routingExtractedHints: string[];
  sessionId?: string;
  userId?: string;
  teamId?: string;
  explicitAlias?: RouteName;
};

export type BudgetCheck = {
  readonly scope: "request" | "user" | "team" | "route";
  readonly status: "ok" | "warning" | "reject";
  readonly reason: string;
  readonly current: number | string;
  readonly limit?: number | string;
};

export type ClassifierOutput = {
  complexity: "trivial" | "simple" | "normal" | "hard" | "deep";
  risk: string[];
  recommended_route: RouteName;
  can_use_fast_model: boolean;
  needs_deep_reasoning: boolean;
  reason_codes: string[];
  confidence: number;
};

export type RouteDecision = {
  outcome: "route" | "reject";
  surface: Surface;
  requestedModel: string;
  classifierRoute?: RouteName;
  finalRoute?: RouteName;
  selectedModel?: string;
  provider?: Provider;
  reasoningEffort?: ReasoningEffort;
  verbosity?: Verbosity;
  guardrailActions: string[];
  reasonCodes: string[];
  budgetChecks?: BudgetCheck[];
  session?: {
    sessionKey: string;
    sessionId: string;
    userId?: string;
    teamId?: string;
    previousRoute?: RouteName;
    currentRoute: RouteName;
    action: "stored" | "upgraded" | "kept" | "explicit_override";
  };
  classifier?: {
    provider: Provider;
    model: string;
    attempts: number;
    confidence: number;
    recommendedRoute: RouteName;
    routingConfigId?: string;
    routingConfigVersionId?: string;
    routingConfigHash?: string;
  };
  routingConfig?: RoutingConfigSnapshot;
  policyVersion: string;
  error?: string;
  errorStatus?: number;
};

export type RoutingConfigSnapshot = {
  configId: string;
  configName: string;
  versionId: string;
  version: number;
  configHash: string;
};

export type RoutingConfigSelection = {
  snapshot: RoutingConfigSnapshot;
  config: RoutingConfig;
};

export type ProviderAttempt = {
  id: string;
  requestId: string;
  surface: Surface;
  provider: Provider;
  model: string;
  terminalStatus: "pending" | "completed" | "failed" | "cancelled";
  usage?: JsonValue;
  upstreamRequestId?: string;
  error?: string;
};
