import type {
  CompressionPolicy,
  Dialect as SchemaDialect,
  Effort,
  HarnessCompatibilityProfileId,
  Provider as SchemaProvider,
  ProviderAdapterKind as SchemaProviderAdapterKind,
  Surface as SchemaSurface,
  Verbosity as SchemaVerbosity
} from "@proxy/schema";

export type Surface = SchemaSurface;
export type Dialect = SchemaDialect;
export type Provider = SchemaProvider;
export type ProviderAdapterKind = SchemaProviderAdapterKind;
export type ReasoningEffort = Effort;
export type ProviderEffort = Effort;
export type Verbosity = SchemaVerbosity;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type PinnedUpstreamAddress = {
  readonly hostname: string;
  readonly address: string;
  readonly family: 4 | 6;
};

export type UpstreamCredential = {
  readonly provider: Provider;
  readonly token: string;
  readonly providerConnectionId: string;
  readonly baseUrl?: string;
  readonly pinnedAddress?: PinnedUpstreamAddress;
  readonly connectionSettings?: JsonObject;
};

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
};

export type RouteDecision = {
  outcome: "route" | "reject";
  surface: Surface;
  requestedModel: string;
  selectedModel?: string;
  provider?: Provider;
  reasoningEffort?: ProviderEffort;
  verbosity?: Verbosity;
  guardrailActions: string[];
  reasonCodes: string[];
  compressionPolicy?: CompressionPolicy;
  selectedAdapterKind?: ProviderAdapterKind;
  policyVersion: string;
  error?: string;
  errorMessage?: string;
  errorDetails?: JsonObject;
  errorStatus?: number;
};

export type ProviderAttempt = {
  id: string;
  requestId: string;
  surface: Surface;
  provider: Provider;
  model: string;
  adapterKind?: ProviderAdapterKind;
  adapterClassification?: JsonObject;
  providerConnectionId?: string;
  deploymentId?: string;
  terminalStatus: "pending" | "completed" | "failed" | "cancelled";
  usage?: JsonValue;
  upstreamRequestId?: string;
  error?: string;
};
