import type {
  Dialect as SchemaDialect,
  Effort,
  CompressionPolicy,
  Provider as SchemaProvider,
  ProviderAccountAuthType,
  ProviderAdapterKind as SchemaProviderAdapterKind,
  RouteExecutionPlan,
  RoutingConfig,
  RoutingConfigRetryPolicy,
  SelectedDeployment,
  SessionPinnedSettings,
  Surface as SchemaSurface,
  HarnessCompatibilityProfileId,
  Verbosity as RoutingVerbosity
} from "@proxy/schema";

export type Surface = SchemaSurface;

export type Dialect = SchemaDialect;

export type Provider = SchemaProvider;

export type ProviderAdapterKind = SchemaProviderAdapterKind;

export type RouteName = "fast" | "balanced" | "hard" | "deep";

export type ReasoningEffort = Effort;
export type ProviderEffort = Effort;

export type PinnedUpstreamAddress = {
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
};

export type UpstreamCredential = {
  readonly provider: Provider;
  readonly token: string;
  readonly providerAccountId: string;
  readonly authType: ProviderAccountAuthType;
  readonly chatgptAccountId?: string;
  readonly baseUrl?: string;
  readonly pinnedAddress?: PinnedUpstreamAddress;
  readonly providerAccountSettings?: JsonObject;
};

export type Verbosity = RoutingVerbosity;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type RouteContext = {
  organizationId?: string;
  workspaceId?: string;
  surface: Surface;
  transport?: "http" | "websocket";
  harness?: "claude-code" | "codex" | "opencode" | "cursor" | "generic";
  harnessProfileId?: HarnessCompatibilityProfileId;
  statefulResponses?: boolean;
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
  isStreaming?: boolean;
  unsupportedFields?: string[];
  extractedHints: string[];
  routingExtractedHints: string[];
  sessionId?: string;
  userId?: string;
  teamId?: string;
  apiKeyId?: string;
  explicitAlias?: RouteName;
};

export type BudgetCheck = {
  readonly scope: "request" | "route";
  readonly status: "ok" | "reject";
  readonly reason: string;
  readonly current: number | string;
  readonly limit: number | string;
};

export type ProviderHealthSkip = {
  readonly scope: "provider_account" | "provider_account_model";
  readonly provider: Provider;
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly model: string;
  readonly healthStatus: string;
  readonly errorType?: string;
  readonly expiresAt?: string;
  readonly metadata?: JsonObject;
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
  deployment?: SelectedDeployment;
  providerAttempts?: RouteProviderAttempt[];
  retryPolicy?: RoutingConfigRetryPolicy;
  reasoningEffort?: ProviderEffort;
  verbosity?: Verbosity;
  providerSettings?: SelectedRouteSettings;
  guardrailActions: string[];
  reasonCodes: string[];
  budgetChecks?: BudgetCheck[];
  healthSkips?: ProviderHealthSkip[];
  session?: {
    sessionKey: string;
    sessionId: string;
    userId?: string;
    teamId?: string;
    previousRoute?: RouteName;
    currentRoute: RouteName;
    pin?: {
      settings: SelectedRouteSettings;
      routingConfigVersionId?: string;
    };
    invalidatedPin?: {
      provider: Provider;
      routingConfigVersionId?: string;
    };
    softFloor: boolean;
    action: "stored" | "upgraded" | "kept" | "capped" | "explicit_override";
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
  compressionPolicy?: CompressionPolicy;
  routeExecutionPlan?: RouteExecutionPlan;
  selectedAdapterKind?: ProviderAdapterKind;
  policyVersion: string;
  error?: string;
  errorMessage?: string;
  errorDetails?: JsonObject;
  errorStatus?: number;
};

export type SelectedRouteSettings = SessionPinnedSettings;

export type RouteProviderAttempt = {
  readonly route: RouteName;
  readonly routeCandidateId?: string;
  readonly selectedModel: string;
  readonly provider: Provider;
  readonly adapterKind?: ProviderAdapterKind;
  readonly deployment: SelectedDeployment;
  readonly reasoningEffort?: ProviderEffort;
  readonly verbosity?: Verbosity;
  readonly providerSettings: SelectedRouteSettings;
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
  compressionPolicy: CompressionPolicy;
};

export type ProviderAttempt = {
  id: string;
  requestId: string;
  surface: Surface;
  provider: Provider;
  model: string;
  adapterKind?: ProviderAdapterKind;
  adapterClassification?: JsonObject;
  providerAccountId?: string;
  terminalStatus: "pending" | "completed" | "failed" | "cancelled";
  usage?: JsonValue;
  upstreamRequestId?: string;
  error?: string;
};
