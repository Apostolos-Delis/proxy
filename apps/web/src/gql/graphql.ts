/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import { DocumentTypeDecoration } from '@graphql-typed-document-node/core';
export type ClassifierSettingsInput = {
  allowRedactedExcerpt?: boolean | null | undefined;
  maxAttempts?: number | null | undefined;
  model?: string | null | undefined;
  timeoutMs?: number | null | undefined;
};

export type CompressionPreviewInput = {
  body?: unknown;
  policy?: ToolResultCompressionPolicyInput | null | undefined;
  requestId?: string | number | null | undefined;
  surface?: string | null | undefined;
};

export type CostBaselineSettingsInput = {
  anthropicMessagesModel: string;
  openaiChatModel: string;
  openaiResponsesModel: string;
};

export type CreateApiKeyInput = {
  name: string;
  routingConfigId?: string | number | null | undefined;
};

export type CreateInvitationInput = {
  email: string;
  name?: string | null | undefined;
  role: MemberRole;
};

export type CreateProviderCredentialFromLocalAuthInput = {
  baseUrl?: string | null | undefined;
  name: string;
  provider: string;
};

export type CreateProviderCredentialInput = {
  accessKeyId?: string | null | undefined;
  apiKey?: string | null | undefined;
  authType?: ProviderAccountAuthType | null | undefined;
  baseUrl?: string | null | undefined;
  chatgptAccountId?: string | null | undefined;
  credentialMode?: string | null | undefined;
  discoveryRegions?: Array<string> | null | undefined;
  endpointOverride?: string | null | undefined;
  name: string;
  provider: string;
  region?: string | null | undefined;
  secretAccessKey?: string | null | undefined;
  sessionToken?: string | null | undefined;
};

export type CreateProviderInput = {
  adapterConfig?: unknown;
  adapterKind?: string | null | undefined;
  authStyle: string;
  baseUrl: string;
  capabilities?: unknown;
  defaultHeaders?: unknown;
  displayName: string;
  enabled?: boolean | null | undefined;
  endpoints: Array<ProviderEndpointInput>;
  forwardHarnessHeaders?: boolean | null | undefined;
  slug: string;
};

export type CreateRoutingConfigInput = {
  config: unknown;
  description?: string | null | undefined;
  name: string;
};

export type CreateWorkspaceInput = {
  description?: string | null | undefined;
  name: string;
  slug?: string | null | undefined;
};

export type MemberRole =
  | 'admin'
  | 'member'
  | 'owner'
  | 'viewer';

export type ModelPricingSource =
  | 'custom'
  | 'default'
  | 'env'
  | 'unpriced';

export type ProbeProviderCredentialInput = {
  model: string;
  operation?: string | null | undefined;
  providerAccountId: string | number;
};

export type PromptCaptureSettingsInput = {
  promptCaptureMode?: string | null | undefined;
  retentionDays?: number | null | undefined;
};

export type ProviderAccountAuthType =
  | 'api_key'
  | 'oauth';

export type ProviderEndpointInput = {
  dialect: string;
  operation?: string | null | undefined;
  path?: string | null | undefined;
};

export type RefreshBedrockModelCatalogInput = {
  providerAccountId: string | number;
};

export type RouteQualitySettingsInput = {
  lowConfidenceThreshold?: number | null | undefined;
};

export type SearchHitKind =
  | 'api_key'
  | 'log'
  | 'routing_config'
  | 'session'
  | 'user';

export type SetModelPricingInput = {
  cacheReadCostPerMtok?: number | null | undefined;
  cacheWriteCostPerMtok?: number | null | undefined;
  inputCostPerMtok: number;
  model: string;
  outputCostPerMtok: number;
  provider: string;
};

export type SettingsInput = {
  automaticCaching?: boolean | null | undefined;
  cacheTtlUpgrade?: boolean | null | undefined;
  classifier?: ClassifierSettingsInput | null | undefined;
  costBaseline?: CostBaselineSettingsInput | null | undefined;
  duplicateToolResultReferences?: boolean | null | undefined;
  promptCapture?: PromptCaptureSettingsInput | null | undefined;
  routeQuality?: RouteQualitySettingsInput | null | undefined;
  schemaVersion?: number | null | undefined;
  systemPrompt?: string | null | undefined;
  toolResultCompressionPolicy?: ToolResultCompressionPolicyInput | null | undefined;
};

export type StartProviderCredentialOAuthInput = {
  name: string;
  provider: string;
};

export type ToolResultCompressionPolicyInput = {
  enabledRules?: Array<string> | null | undefined;
  minOriginalBytes?: number | null | undefined;
  minSavingsTokens?: number | null | undefined;
  mode?: string | null | undefined;
  storeCompressedArtifact?: boolean | null | undefined;
  storeOriginalArtifact?: boolean | null | undefined;
};

export type UpdateProviderCredentialInput = {
  accessKeyId?: string | null | undefined;
  apiKey?: string | null | undefined;
  baseUrl?: string | null | undefined;
  credentialMode?: string | null | undefined;
  discoveryRegions?: Array<string> | null | undefined;
  endpointOverride?: string | null | undefined;
  name?: string | null | undefined;
  providerAccountId: string | number;
  region?: string | null | undefined;
  secretAccessKey?: string | null | undefined;
  sessionToken?: string | null | undefined;
};

export type UpdateProviderInput = {
  adapterConfig?: unknown;
  adapterKind?: string | null | undefined;
  authStyle: string;
  baseUrl: string;
  capabilities?: unknown;
  defaultHeaders?: unknown;
  displayName: string;
  enabled?: boolean | null | undefined;
  endpoints: Array<ProviderEndpointInput>;
  forwardHarnessHeaders?: boolean | null | undefined;
  providerId: string | number;
};

export type UsageGroupBy =
  | 'api_key'
  | 'model'
  | 'model_effort'
  | 'provider'
  | 'route'
  | 'session'
  | 'surface'
  | 'user';

export type UsageInterval =
  | 'day'
  | 'hour';

export type BillingPageQueryVariables = Exact<{ [key: string]: never; }>;


export type BillingPageQuery = { overview: { requestCount: number, cost: { selected: number, baseline: number, savings: number } } };

export type TokenAttributionViewQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
}>;


export type TokenAttributionViewQuery = { tokenAttribution: { requestCount: number, sampled: boolean, buckets: Array<{ key: string, chars: number, estimatedTokens: number }>, toolSchemas: Array<{ name: string, chars: number, estimatedTokens: number, blocks: number | null }>, toolResults: Array<{ name: string, chars: number, estimatedTokens: number, blocks: number | null }>, schemaChurn: Array<{ name: string, estimatedTokens: number, requests: number, sessions: number, schemaHashes: number, churningSessions: number, status: string }> } };

export type IdleGapsViewQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
}>;


export type IdleGapsViewQuery = { idleGaps: { totalGaps: number, overTtl: number, recoverableByOneHourTtl: number, estimatedRecoverableCacheReadTokens: number, recommendationThresholdTokens: number, recommendedTtlUpgrade: boolean, sessionsScanned: number, sampledRequests: number, sampleWindowStart: string | null, sampleWindowEnd: string | null, sampled: boolean, buckets: Array<{ key: string, label: string, count: number }> } };

export type CacheBustsViewQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
}>;


export type CacheBustsViewQuery = { cacheBusts: { countsByCause: unknown, sessionsScanned: number, sampled: boolean, busts: Array<{ sessionId: string, requestId: string, at: string, cause: string, droppedCacheReadTokens: number, rebuiltTokens: number, model: string, gapMs: number }> } };

export type CompressionSavingsViewQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
}>;


export type CompressionSavingsViewQuery = { compressionSavings: { eventCount: number, sampled: boolean, blocks: number, savedChars: number, savedEstimatedTokens: number, rows: Array<{ rule: string, ruleVersion: number, tool: string, blocks: number, savedChars: number, savedEstimatedTokens: number }> } };

export type PromptCachePlansViewQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
}>;


export type PromptCachePlansViewQuery = { promptCachePlans: { totalPlans: number, sampled: boolean, plans: Array<{ provider: string, model: string, mode: string, count: number, appliedControls: number, skippedControls: number }>, controls: Array<{ provider: string, model: string, mode: string, control: string, status: string, reason: string, count: number }> } };

export type PromptCachePrewarmsViewQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
}>;


export type PromptCachePrewarmsViewQuery = { promptCachePrewarms: { totalJobs: number, sampled: boolean, estimatedCostMicros: number, actualCostMicros: number, expiredUnusedCostMicros: number, cacheReadLiftTokens: number, jobs: Array<{ provider: string, model: string, status: string, count: number, estimatedCostMicros: number, actualCostMicros: number, expiredUnusedCostMicros: number, cacheReadLiftTokens: number }> } };

export type OpenAiCacheAnalyticsViewQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
  interval?: UsageInterval | null | undefined;
}>;


export type OpenAiCacheAnalyticsViewQuery = { openAICacheAnalytics: { interval: UsageInterval, totals: { requestCount: number, cachedRequests: number, inputTokens: number, cachedInputTokens: number, cacheHitRate: number, requestHitRate: number }, groups: Array<{ surface: string, provider: string, model: string, route: string, cacheGroupSource: string, cacheGroupKey: string, requestCount: number, cachedRequests: number, inputTokens: number, cachedInputTokens: number, cacheHitRate: number, requestHitRate: number }>, trends: Array<{ ts: string, requestCount: number, cachedRequests: number, inputTokens: number, cachedInputTokens: number, cacheHitRate: number, requestHitRate: number }> } };

export type CachePricingRatesQueryVariables = Exact<{ [key: string]: never; }>;


export type CachePricingRatesQuery = { modelPricing: Array<{ model: string, inputCostPerMtok: number | null, cacheReadCostPerMtok: number | null, cacheWriteCostPerMtok: number | null }> };

export type CompressionPreviewPanelQueryVariables = Exact<{
  input: CompressionPreviewInput;
}>;


export type CompressionPreviewPanelQuery = { compressionPreview: { contentAvailable: boolean, contentRedactionReason: string | null, blocks: number, savedBytes: number, savedTokens: number, previewBlocks: Array<{ blockPath: string, toolName: string, ruleId: string, status: string, skipReason: string | null, retrievalId: string | null, retrievalAvailable: boolean, retrievalMarker: string | null, originalBytes: number, compressedBytes: number, savedTokens: number, diffSegments: Array<{ side: string, text: string }> }> } };

export type InvitationsListQueryVariables = Exact<{ [key: string]: never; }>;


export type InvitationsListQuery = { invitations: Array<{ id: string, email: string, name: string | null, role: string, status: string, lastSentAt: string | null, expiresAt: string, invitedBy: { userId: string, name: string | null, email: string | null } | null }> };

export type ResendInvitationMutationVariables = Exact<{
  invitationId: string | number;
}>;


export type ResendInvitationMutation = { resendInvitation: { inviteUrl: string, emailDelivery: { transport: string, delivered: boolean, error: string | null } } };

export type RevokeInvitationMutationVariables = Exact<{
  invitationId: string | number;
}>;


export type RevokeInvitationMutation = { revokeInvitation: { id: string, status: string } | null };

export type PublicInvitationQueryVariables = Exact<{
  token: string;
}>;


export type PublicInvitationQuery = { publicInvitation: { organizationName: string, email: string, name: string | null, role: string, status: string, inviterName: string | null, expiresAt: string } | null };

export type AcceptInvitationMutationVariables = Exact<{
  token: string;
  name?: string | null | undefined;
}>;


export type AcceptInvitationMutation = { acceptInvitation: { ok: boolean, organizationId: string, userId: string, email: string, role: string } };

export type CreateInvitationMutationVariables = Exact<{
  input: CreateInvitationInput;
}>;


export type CreateInvitationMutation = { createInvitation: { inviteUrl: string, emailDelivery: { transport: string, delivered: boolean, error: string | null } } };

export type KeyTrafficRequestsQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
  limit?: number | null | undefined;
}>;


export type KeyTrafficRequestsQuery = { requests: Array<{ requestId: string, createdAt: string | null, provider: string | null, apiKeyId: string | null, selectedModel: string | null, terminalStatus: string, selectedCost: number, baselineCost: number, usage: { totalTokens: number } }> };

export type ModelPricingCardQueryVariables = Exact<{ [key: string]: never; }>;


export type ModelPricingCardQuery = { modelPricing: Array<{ model: string, provider: string | null, source: ModelPricingSource, seenInTraffic: boolean, inputCostPerMtok: number | null, outputCostPerMtok: number | null, cacheReadCostPerMtok: number | null, cacheWriteCostPerMtok: number | null, updatedAt: string | null }> };

export type SetModelPricingMutationVariables = Exact<{
  input: SetModelPricingInput;
}>;


export type SetModelPricingMutation = { setModelPricing: Array<{ model: string, provider: string | null, source: ModelPricingSource, seenInTraffic: boolean, inputCostPerMtok: number | null, outputCostPerMtok: number | null, cacheReadCostPerMtok: number | null, cacheWriteCostPerMtok: number | null, updatedAt: string | null }> };

export type ClearModelPricingMutationVariables = Exact<{
  provider: string;
  model: string;
}>;


export type ClearModelPricingMutation = { clearModelPricing: Array<{ model: string, provider: string | null, source: ModelPricingSource, seenInTraffic: boolean, inputCostPerMtok: number | null, outputCostPerMtok: number | null, cacheReadCostPerMtok: number | null, cacheWriteCostPerMtok: number | null, updatedAt: string | null }> };

export type OverviewPageQueryVariables = Exact<{ [key: string]: never; }>;


export type OverviewPageQuery = { overviewDashboard: { overview: { requestCount: number, totals: { totalTokens: number }, cost: { selected: number, baseline: number, savings: number }, routeQuality: { lowConfidenceCount: number, cheaperLikelyWouldWorkCount: number, cheapCausedRetriesOrRepairsCount: number } }, requests: Array<{ createdAt: string | null, selectedCost: number, baselineCost: number, usage: { totalTokens: number } }>, modelUsage: { data: Array<{ key: string, usage: { totalTokens: number }, cost: { selected: number } }> } } };

export type PromptDetailViewQueryVariables = Exact<{
  artifactId: string | number;
}>;


export type PromptDetailViewQuery = { prompt: { artifact: { artifactId: string, requestId: string, userId: string | null, sessionId: string | null, surface: string, kind: string, sourceIndex: number | null, storageMode: string, contentHash: string, chars: number | null, tokenEstimate: number | null, preview: string | null, rawText: string | null, redactedText: string | null, expiresAt: string | null, finalRoute: string | null, provider: string | null, selectedModel: string | null, classifier: unknown, metadata: unknown, createdAt: string, routingConfig: { configId: string, configName: string | null, versionId: string | null, version: number | null, configHash: string | null } | null, cost: { selected: number } }, requestArtifacts: Array<{ artifactId: string, requestId: string, userId: string | null, sessionId: string | null, surface: string, kind: string, sourceIndex: number | null, storageMode: string, contentHash: string, chars: number | null, tokenEstimate: number | null, preview: string | null, rawText: string | null, redactedText: string | null, expiresAt: string | null, finalRoute: string | null, provider: string | null, selectedModel: string | null, classifier: unknown, metadata: unknown, createdAt: string, routingConfig: { configId: string, configName: string | null, versionId: string | null, version: number | null, configHash: string | null } | null, cost: { selected: number } }>, routeDecisions: Array<{ selectedProvider: string | null, selectedModel: string | null, classifierRoute: string | null, finalRoute: string | null, confidence: number | null, routeExecutionPlan: unknown, selectedCandidateId: string | null, translated: boolean, translatorId: string | null, routingConfig: { configId: string, configName: string | null, versionId: string | null, version: number | null, configHash: string | null } | null }>, providerAttempts: Array<{ id: string, requestId: string, provider: string, model: string, terminalStatus: string, statusCode: number | null, error: string | null, routeCandidateId: string | null, attemptIndex: number | null, fallbackIndex: number | null, skipReason: string | null }>, request: { requestId: string, terminalStatus: string, finalRoute: string | null, requestedModel: string | null, selectedModel: string | null, provider: string | null, latencyMs: number | null, timeToFirstByteMs: number | null, selectedCost: number, classifier: unknown, usage: { inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, routingConfig: { configId: string, configName: string | null, versionId: string | null, version: number | null, configHash: string | null } | null } | null, compressionReceipts: Array<{ id: string, mode: string, surface: string, blockPath: string, toolName: string, command: string | null, commandClass: string | null, ruleId: string, ruleVersion: number, status: string, skipReason: string | null, retrievalId: string | null, retrievalAvailable: boolean, retrievalMarker: string | null, originalBytes: number, compressedBytes: number, savedBytes: number, originalTokenEstimate: number, compressedTokenEstimate: number, savedTokens: number, estimateSource: string, originalSha256: string, compressedSha256: string, originalArtifactId: string | null, compressedArtifactId: string | null, originalArtifactExpiresAt: string | null, compressedArtifactExpiresAt: string | null }>, events: Array<{ eventId: string, eventType: string, producer: string, payload: unknown, createdAt: string }> } | null };

export type PromptsListQueryVariables = Exact<{ [key: string]: never; }>;


export type PromptsListQuery = { prompts: { data: Array<{ artifactId: string, userId: string | null, sessionId: string | null, surface: string, kind: string, preview: string | null, finalRoute: string | null, selectedModel: string | null, createdAt: string, routingConfig: { configId: string, configName: string | null, version: number | null, configHash: string | null } | null, cost: { selected: number } }> } };

export type SubscriptionAuthSettingQueryVariables = Exact<{ [key: string]: never; }>;


export type SubscriptionAuthSettingQuery = { settings: { subscriptionOAuthEnabled: boolean } };

export type ProviderAccountsQueryVariables = Exact<{ [key: string]: never; }>;


export type ProviderAccountsQuery = { providerAccounts: Array<{ id: string, organizationId: string, provider: string, name: string, authType: ProviderAccountAuthType, status: string, baseUrl: string | null, secretHint: string | null, credentialMode: string | null, credentialSourceCategory: string | null, region: string | null, endpointOverride: string | null, discoveryRegions: Array<string>, ownerUserId: string | null, boundKeyCount: number, createdAt: string, lastUsedAt: string | null, health: { status: string | null, cooldownUntil: string | null, lastErrorType: string | null, lastErrorAt: string | null, lastSuccessAt: string | null, lastCheckedAt: string | null, consecutiveFailures: number, metadata: unknown, modelHealth: Array<{ providerId: string, providerAccountId: string, model: string, status: string, lastErrorType: string | null, lastErrorAt: string | null, lockoutUntil: string | null, consecutiveFailures: number, lastSuccessAt: string | null, metadata: unknown }> } | null }> };

export type ProviderRegistryQueryVariables = Exact<{ [key: string]: never; }>;


export type ProviderRegistryQuery = { providers: Array<{ id: string, organizationId: string | null, slug: string, displayName: string, baseUrl: string, adapterKind: string, authStyle: string, defaultHeaders: unknown, capabilities: unknown, forwardHarnessHeaders: boolean, enabled: boolean, builtin: boolean, endpoints: Array<{ dialect: string, path: string | null, operation: string | null }> }> };

export type CreateProviderCredentialMutationVariables = Exact<{
  input: CreateProviderCredentialInput;
}>;


export type CreateProviderCredentialMutation = { createProviderCredential: { id: string, name: string } | null };

export type UpdateProviderCredentialMutationVariables = Exact<{
  input: UpdateProviderCredentialInput;
}>;


export type UpdateProviderCredentialMutation = { updateProviderCredential: { id: string, name: string, credentialMode: string | null, credentialSourceCategory: string | null, region: string | null, endpointOverride: string | null, discoveryRegions: Array<string> } | null };

export type CreateProviderCredentialFromLocalAuthMutationVariables = Exact<{
  input: CreateProviderCredentialFromLocalAuthInput;
}>;


export type CreateProviderCredentialFromLocalAuthMutation = { createProviderCredentialFromLocalAuth: { id: string, name: string } | null };

export type StartProviderCredentialOAuthMutationVariables = Exact<{
  input: StartProviderCredentialOAuthInput;
}>;


export type StartProviderCredentialOAuthMutation = { startProviderCredentialOAuth: { loginId: string, verificationUrl: string, userCode: string | null } };

export type CancelProviderCredentialOAuthMutationVariables = Exact<{
  loginId: string | number;
}>;


export type CancelProviderCredentialOAuthMutation = { cancelProviderCredentialOAuth: { loginId: string, status: string, providerAccountId: string | null, error: string | null } | null };

export type ProviderCredentialOAuthStatusQueryVariables = Exact<{
  loginId: string | number;
}>;


export type ProviderCredentialOAuthStatusQuery = { providerCredentialOAuthStatus: { loginId: string, status: string, providerAccountId: string | null, error: string | null } | null };

export type CreateProviderMutationVariables = Exact<{
  input: CreateProviderInput;
}>;


export type CreateProviderMutation = { createProvider: { id: string, slug: string, displayName: string, baseUrl: string, authStyle: string, enabled: boolean, builtin: boolean } | null };

export type UpdateProviderMutationVariables = Exact<{
  input: UpdateProviderInput;
}>;


export type UpdateProviderMutation = { updateProvider: { id: string, slug: string, displayName: string, baseUrl: string, authStyle: string, enabled: boolean, builtin: boolean } | null };

export type DisableProviderMutationVariables = Exact<{
  providerId: string | number;
}>;


export type DisableProviderMutation = { disableProvider: { id: string, enabled: boolean } | null };

export type RevokeProviderCredentialMutationVariables = Exact<{
  providerAccountId: string | number;
}>;


export type RevokeProviderCredentialMutation = { revokeProviderCredential: { id: string, status: string } | null };

export type ProbeProviderCredentialMutationVariables = Exact<{
  input: ProbeProviderCredentialInput;
}>;


export type ProbeProviderCredentialMutation = { probeProviderCredential: { probeId: string, providerAccountId: string, provider: string, model: string, status: string, healthStatus: string, errorType: string | null, message: string | null, statusCode: number | null, latencyMs: number, checkedAt: string, stateUpdated: boolean, dimensions: unknown } };

export type RefreshBedrockModelCatalogMutationVariables = Exact<{
  input: RefreshBedrockModelCatalogInput;
}>;


export type RefreshBedrockModelCatalogMutation = { refreshBedrockModelCatalog: { providerAccountId: string, regions: Array<string>, status: string, error: string | null, modelsSeen: number, modelsApplied: number, inserted: number, updated: number, skipped: number, errors: Array<{ region: string, error: string }> } };

export type AssignApiKeyProviderAccountMutationVariables = Exact<{
  apiKeyId: string | number;
  provider: string;
  providerAccountId?: string | number | null | undefined;
}>;


export type AssignApiKeyProviderAccountMutation = { assignApiKeyProviderAccount: { id: string, providerCredentials: Array<{ provider: string, providerAccountId: string, name: string | null, status: string | null }> } };

export type RequestsPageQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
  limit?: number | null | undefined;
}>;


export type RequestsPageQuery = { prompts: { data: Array<{ artifactId: string, requestId: string, sessionId: string | null, userId: string | null, surface: string, kind: string, preview: string | null, tokenEstimate: number | null, selectedModel: string | null, finalRoute: string | null, provider: string | null, createdAt: string, routingConfig: { configId: string, configName: string | null, version: number | null, configHash: string | null } | null, cost: { selected: number } }> }, requests: Array<{ requestId: string, selectedModel: string | null, terminalStatus: string, latencyMs: number | null, finalRoute: string | null, provider: string | null, selectedCandidateId: string | null, translated: boolean | null, routeSkipReasons: Array<string>, apiKeyId: string | null, sessionId: string | null, selectedCost: number, usage: { totalTokens: number }, routingConfig: { configId: string, configName: string | null, version: number | null, configHash: string | null } | null }>, users: Array<{ userId: string, name: string | null, email: string | null }> };

export type RoutingConfigSummaryFieldsFragment = { id: string, name: string, slug: string, description: string | null, status: string, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routes: Array<{ route: string, description: string | null, targets: Array<{ providerId: string, model: string, effort: string | null, effectiveEffort: string | null }> }> };

export type RoutingConfigDetailFieldsFragment = { config: { id: string, name: string, slug: string, description: string | null, status: string, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routes: Array<{ route: string, description: string | null, targets: Array<{ providerId: string, model: string, effort: string | null, effectiveEffort: string | null }> }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> };

export type RoutingConfigsListQueryVariables = Exact<{ [key: string]: never; }>;


export type RoutingConfigsListQuery = { routingConfigs: Array<{ trafficShare: number, id: string, name: string, slug: string, description: string | null, status: string, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routes: Array<{ route: string, description: string | null, targets: Array<{ providerId: string, model: string, effort: string | null, effectiveEffort: string | null }> }> }> };

export type RoutingConfigDetailViewQueryVariables = Exact<{
  configId: string | number;
}>;


export type RoutingConfigDetailViewQuery = { routingConfig: { config: { id: string, name: string, slug: string, description: string | null, status: string, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routes: Array<{ route: string, description: string | null, targets: Array<{ providerId: string, model: string, effort: string | null, effectiveEffort: string | null }> }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } | null };

export type RoutingApiKeysQueryVariables = Exact<{ [key: string]: never; }>;


export type RoutingApiKeysQuery = { apiKeys: Array<{ id: string, name: string, userId: string | null, routingConfigId: string | null, createdAt: string, expiresAt: string | null, revokedAt: string | null, lastUsedAt: string | null, routingConfig: { id: string, name: string | null, status: string | null } | null, providerCredentials: Array<{ provider: string, providerAccountId: string, name: string | null, status: string | null }> }> };

export type RoutingModelCatalogQueryVariables = Exact<{ [key: string]: never; }>;


export type RoutingModelCatalogQuery = { providers: Array<{ slug: string, displayName: string, authStyle: string, adapterKind: string, enabled: boolean, builtin: boolean, capabilities: unknown, endpoints: Array<{ dialect: string, path: string | null, operation: string | null }> }>, modelCatalog: Array<{ provider: string, model: string, displayName: string | null, catalogSource: string, providerAccountId: string | null, region: string | null, bedrockModelSource: string | null, bedrockInferenceProfileArn: string | null, bedrockInferenceProfileId: string | null, bedrockInferenceProfileSource: string | null, bedrockInferenceProfileGeography: string | null, bedrockBaseModelId: string | null, bedrockFoundationModelId: string | null, dialects: Array<string>, contextWindow: number | null, maxOutputTokens: number | null, supportsStreaming: boolean | null, supportsTools: boolean | null, supportsImages: boolean | null, supportsReasoning: boolean | null, warnings: Array<string>, pricingKnown: boolean, inputCostPerMtok: number | null, outputCostPerMtok: number | null }>, providerAccounts: Array<{ id: string, providerId: string, provider: string, name: string, status: string, credentialMode: string | null, credentialSourceCategory: string | null, region: string | null, endpointOverride: string | null, discoveryRegions: Array<string>, health: { status: string | null, lastErrorType: string | null, cooldownUntil: string | null, metadata: unknown, modelHealth: Array<{ model: string, status: string, lastErrorType: string | null, lockoutUntil: string | null, metadata: unknown }> } | null }> };

export type CreateApiKeyMutationVariables = Exact<{
  input: CreateApiKeyInput;
}>;


export type CreateApiKeyMutation = { createApiKey: { secret: string, apiKey: { id: string, name: string } | null } };

export type RevokeApiKeyMutationVariables = Exact<{
  apiKeyId: string | number;
}>;


export type RevokeApiKeyMutation = { revokeApiKey: { id: string, revokedAt: string | null } };

export type ApiKeyVerificationQueryVariables = Exact<{
  apiKeyId: string | number;
}>;


export type ApiKeyVerificationQuery = { apiKey: { id: string, lastUsedAt: string | null } | null };

export type CreateRoutingConfigMutationVariables = Exact<{
  input: CreateRoutingConfigInput;
}>;


export type CreateRoutingConfigMutation = { createRoutingConfig: { config: { id: string, name: string, slug: string, description: string | null, status: string, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routes: Array<{ route: string, description: string | null, targets: Array<{ providerId: string, model: string, effort: string | null, effectiveEffort: string | null }> }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } };

export type CreateRoutingConfigVersionMutationVariables = Exact<{
  configId: string | number;
  config: unknown;
}>;


export type CreateRoutingConfigVersionMutation = { createRoutingConfigVersion: { config: { id: string, name: string, slug: string, description: string | null, status: string, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routes: Array<{ route: string, description: string | null, targets: Array<{ providerId: string, model: string, effort: string | null, effectiveEffort: string | null }> }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } };

export type ActivateRoutingConfigVersionMutationVariables = Exact<{
  configId: string | number;
  versionId: string | number;
}>;


export type ActivateRoutingConfigVersionMutation = { activateRoutingConfigVersion: { config: { id: string, name: string, slug: string, description: string | null, status: string, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routes: Array<{ route: string, description: string | null, targets: Array<{ providerId: string, model: string, effort: string | null, effectiveEffort: string | null }> }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } };

export type ArchiveRoutingConfigMutationVariables = Exact<{
  configId: string | number;
}>;


export type ArchiveRoutingConfigMutation = { archiveRoutingConfig: { config: { id: string, name: string, slug: string, description: string | null, status: string, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routes: Array<{ route: string, description: string | null, targets: Array<{ providerId: string, model: string, effort: string | null, effectiveEffort: string | null }> }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } };

export type AssignRoutingConfigKeyMutationVariables = Exact<{
  apiKeyId: string | number;
  routingConfigId?: string | number | null | undefined;
}>;


export type AssignRoutingConfigKeyMutation = { assignApiKeyRoutingConfig: { id: string, routingConfigId: string | null } };

export type GlobalSearchQueryVariables = Exact<{
  query: string;
}>;


export type GlobalSearchQuery = { search: { results: Array<{ kind: SearchHitKind, id: string, title: string, subtitle: string | null, status: string | null, snippet: string | null, occurredAt: string | null }> } };

export type ViewerFieldsFragment = { organizationId: string, workspaceId: string, user: { sessionId: string, organizationId: string, workspaceId: string, userId: string, email: string | null, name: string | null, role: string }, organizations: Array<{ id: string, slug: string, name: string, role: string }>, workspaces: Array<{ id: string, slug: string, name: string }> };

export type ViewerQueryVariables = Exact<{ [key: string]: never; }>;


export type ViewerQuery = { viewer: { organizationId: string, workspaceId: string, user: { sessionId: string, organizationId: string, workspaceId: string, userId: string, email: string | null, name: string | null, role: string }, organizations: Array<{ id: string, slug: string, name: string, role: string }>, workspaces: Array<{ id: string, slug: string, name: string }> } };

export type LoginMutationVariables = Exact<{
  email: string;
  password: string;
}>;


export type LoginMutation = { login: { organizationId: string, workspaceId: string, user: { sessionId: string, organizationId: string, workspaceId: string, userId: string, email: string | null, name: string | null, role: string }, organizations: Array<{ id: string, slug: string, name: string, role: string }>, workspaces: Array<{ id: string, slug: string, name: string }> } };

export type LogoutMutationVariables = Exact<{ [key: string]: never; }>;


export type LogoutMutation = { logout: boolean };

export type SwitchOrganizationMutationVariables = Exact<{
  organizationId: string | number;
}>;


export type SwitchOrganizationMutation = { switchOrganization: { organizationId: string, workspaceId: string, user: { sessionId: string, organizationId: string, workspaceId: string, userId: string, email: string | null, name: string | null, role: string }, organizations: Array<{ id: string, slug: string, name: string, role: string }>, workspaces: Array<{ id: string, slug: string, name: string }> } };

export type SwitchWorkspaceMutationVariables = Exact<{
  workspaceId: string | number;
}>;


export type SwitchWorkspaceMutation = { switchWorkspace: { organizationId: string, workspaceId: string, user: { sessionId: string, organizationId: string, workspaceId: string, userId: string, email: string | null, name: string | null, role: string }, organizations: Array<{ id: string, slug: string, name: string, role: string }>, workspaces: Array<{ id: string, slug: string, name: string }> } };

export type CreateWorkspaceMutationVariables = Exact<{
  input: CreateWorkspaceInput;
}>;


export type CreateWorkspaceMutation = { createWorkspace: { id: string, slug: string, name: string } };

export type SessionDetailViewQueryVariables = Exact<{
  sessionId: string | number;
}>;


export type SessionDetailViewQuery = { session: { user: unknown, session: { sessionId: string, externalSessionId: string | null, userId: string | null, surface: string, sessionIdentity: string | null, requestCount: number, startedAt: string, usage: { inputTokens: number, outputTokens: number }, cost: { selected: number } }, requests: Array<{ requestId: string, createdAt: string | null, selectedModel: string | null, finalRoute: string | null, terminalStatus: string, latencyMs: number | null, selectedCost: number, usage: { inputTokens: number, cachedInputTokens: number, outputTokens: number, totalTokens: number } }>, promptArtifacts: Array<{ artifactId: string, requestId: string, kind: string, sourceIndex: number | null, contentHash: string, chars: number | null, createdAt: string, preview: string | null, tokenEstimate: number | null, metadata: unknown }> } | null };

export type SessionsPageQueryVariables = Exact<{ [key: string]: never; }>;


export type SessionsPageQuery = { sessions: Array<{ sessionId: string, externalSessionId: string | null, userId: string | null, surface: string, currentRoute: string | null, requestCount: number, startedAt: string, endedAt: string | null, recentActivity: string | null, modelMix: unknown, routeMix: unknown, terminalStatusSummary: unknown, usage: { totalTokens: number }, cost: { selected: number } }>, users: Array<{ userId: string, name: string | null, email: string | null }> };

export type SettingsViewFieldsFragment = { organizationId: string, databaseEnabled: boolean, subscriptionOAuthEnabled: boolean, restartRequiredFor: Array<string>, storage: { path: string, reason: string }, settings: { schemaVersion: number, systemPrompt: string | null, cacheTtlUpgrade: boolean, automaticCaching: boolean, duplicateToolResultReferences: boolean, toolResultCompressionPolicy: { mode: string, minOriginalBytes: number | null, minSavingsTokens: number | null, enabledRules: Array<string>, storeOriginalArtifact: boolean | null, storeCompressedArtifact: boolean | null }, costBaseline: { anthropicMessagesModel: string, openaiResponsesModel: string, openaiChatModel: string }, classifier: { model: string, timeoutMs: number, maxAttempts: number, allowRedactedExcerpt: boolean }, routeQuality: { lowConfidenceThreshold: number }, promptCapture: { promptCaptureMode: string, retentionDays: number } } };

export type SettingsViewQueryVariables = Exact<{ [key: string]: never; }>;


export type SettingsViewQuery = { settings: { organizationId: string, databaseEnabled: boolean, subscriptionOAuthEnabled: boolean, restartRequiredFor: Array<string>, storage: { path: string, reason: string }, settings: { schemaVersion: number, systemPrompt: string | null, cacheTtlUpgrade: boolean, automaticCaching: boolean, duplicateToolResultReferences: boolean, toolResultCompressionPolicy: { mode: string, minOriginalBytes: number | null, minSavingsTokens: number | null, enabledRules: Array<string>, storeOriginalArtifact: boolean | null, storeCompressedArtifact: boolean | null }, costBaseline: { anthropicMessagesModel: string, openaiResponsesModel: string, openaiChatModel: string }, classifier: { model: string, timeoutMs: number, maxAttempts: number, allowRedactedExcerpt: boolean }, routeQuality: { lowConfidenceThreshold: number }, promptCapture: { promptCaptureMode: string, retentionDays: number } } } };

export type UpdateSettingsMutationVariables = Exact<{
  input: SettingsInput;
}>;


export type UpdateSettingsMutation = { updateSettings: { organizationId: string, databaseEnabled: boolean, subscriptionOAuthEnabled: boolean, restartRequiredFor: Array<string>, storage: { path: string, reason: string }, settings: { schemaVersion: number, systemPrompt: string | null, cacheTtlUpgrade: boolean, automaticCaching: boolean, duplicateToolResultReferences: boolean, toolResultCompressionPolicy: { mode: string, minOriginalBytes: number | null, minSavingsTokens: number | null, enabledRules: Array<string>, storeOriginalArtifact: boolean | null, storeCompressedArtifact: boolean | null }, costBaseline: { anthropicMessagesModel: string, openaiResponsesModel: string, openaiChatModel: string }, classifier: { model: string, timeoutMs: number, maxAttempts: number, allowRedactedExcerpt: boolean }, routeQuality: { lowConfidenceThreshold: number }, promptCapture: { promptCaptureMode: string, retentionDays: number } } } };

export type UsageGroupFieldsFragment = { key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number, classifier: number } };

export type UsageGroupCostFieldsFragment = { key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number, classifier: number } };

export type UsageGroupDashboardFieldsFragment = { key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number } };

export type UsageGroupChartFieldsFragment = { key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, totalTokens: number }, cost: { selected: number } };

export type UsageReportViewQueryVariables = Exact<{
  groupBy: UsageGroupBy;
  start?: string | null | undefined;
  end?: string | null | undefined;
}>;


export type UsageReportViewQuery = { usage: { groupBy: UsageGroupBy, data: Array<{ key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number, classifier: number } }>, totals: { key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number, classifier: number } } } };

export type UsageTimeseriesViewQueryVariables = Exact<{
  groupBy: UsageGroupBy;
  interval?: UsageInterval | null | undefined;
  start?: string | null | undefined;
  end?: string | null | undefined;
  limit?: number | null | undefined;
}>;


export type UsageTimeseriesViewQuery = { usageTimeseries: { groupBy: UsageGroupBy, interval: UsageInterval, start: string, end: string, groups: Array<{ key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number, classifier: number } }>, points: Array<{ ts: string, groups: unknown, totals: { key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number, classifier: number } } }> } };

export type UsageDashboardViewQueryVariables = Exact<{
  groupBy: UsageGroupBy;
  interval?: UsageInterval | null | undefined;
  start?: string | null | undefined;
  end?: string | null | undefined;
  limit?: number | null | undefined;
}>;


export type UsageDashboardViewQuery = { usageDashboard: { usage: { groupBy: UsageGroupBy, data: Array<{ key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number } }>, totals: { key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number } } }, timeseries: { groupBy: UsageGroupBy, interval: UsageInterval, start: string, end: string, groups: Array<{ key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, totalTokens: number }, cost: { selected: number } }>, points: Array<{ ts: string, groups: unknown, totals: { key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, totalTokens: number }, cost: { selected: number } } }> } } };

export type UsageCostDashboardViewQueryVariables = Exact<{
  groupBy: UsageGroupBy;
  interval?: UsageInterval | null | undefined;
  start?: string | null | undefined;
  end?: string | null | undefined;
  limit?: number | null | undefined;
}>;


export type UsageCostDashboardViewQuery = { usageDashboard: { usage: { groupBy: UsageGroupBy, data: Array<{ key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number, classifier: number } }>, totals: { key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, cacheCreationInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number, classifier: number } } }, timeseries: { groupBy: UsageGroupBy, interval: UsageInterval, start: string, end: string, groups: Array<{ key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, totalTokens: number }, cost: { selected: number } }>, points: Array<{ ts: string, groups: unknown, totals: { key: string, requestCount: number, usage: { inputTokens: number, cachedInputTokens: number, totalTokens: number }, cost: { selected: number } } }> } } };

export type UsageLookupsQueryVariables = Exact<{ [key: string]: never; }>;


export type UsageLookupsQuery = { members: Array<{ userId: string, name: string | null, email: string | null }>, apiKeys: Array<{ id: string, name: string, revokedAt: string | null }> };

export type RouteOutputViewQueryVariables = Exact<{
  start?: string | null | undefined;
  end?: string | null | undefined;
}>;


export type RouteOutputViewQuery = { routeOutputReport: { routes: Array<{ route: string, requests: number, outputTokens: number, reasoningTokens: number, avgOutputTokens: number, reasoningShare: number, outputCost: number }>, models: Array<{ key: string, requests: number, outputTokens: number, reasoningTokens: number, avgOutputTokens: number, reasoningShare: number, outputCost: number }>, users: Array<{ key: string, requests: number, outputTokens: number, reasoningTokens: number, avgOutputTokens: number, reasoningShare: number, outputCost: number }>, apiKeys: Array<{ key: string, requests: number, outputTokens: number, reasoningTokens: number, avgOutputTokens: number, reasoningShare: number, outputCost: number }>, workspaces: Array<{ key: string, requests: number, outputTokens: number, reasoningTokens: number, avgOutputTokens: number, reasoningShare: number, outputCost: number }> } };

export type UnpricedModelsQueryVariables = Exact<{ [key: string]: never; }>;


export type UnpricedModelsQuery = { modelPricing: Array<{ model: string, provider: string | null, source: ModelPricingSource, seenInTraffic: boolean }> };

export type UserDirectoryQueryVariables = Exact<{ [key: string]: never; }>;


export type UserDirectoryQuery = { users: Array<{ userId: string, name: string | null, email: string | null }> };

export type DeactivateUserMutationVariables = Exact<{
  userId: string | number;
}>;


export type DeactivateUserMutation = { deactivateUser: { userId: string, status: string } };

export type ReactivateUserMutationVariables = Exact<{
  userId: string | number;
}>;


export type ReactivateUserMutation = { reactivateUser: { userId: string, status: string } };

export type UsersListQueryVariables = Exact<{ [key: string]: never; }>;


export type UsersListQuery = { users: Array<{ userId: string, email: string | null, name: string | null, externalId: string | null, apiKeyCount: number, requestCount: number, sessionCount: number, recentActivity: string | null, createdAt: string, membership: { role: string, status: string } | null, usage: { totalTokens: number }, cost: { selected: number }, usage30d: { totalTokens: number }, cost30d: { selected: number } }> };

export type UpdateUserRoleMutationVariables = Exact<{
  userId: string | number;
  role: MemberRole;
}>;


export type UpdateUserRoleMutation = { updateUserRole: { userId: string, role: string, previousRole: string } };

export class TypedDocumentString<TResult, TVariables>
  extends String
  implements DocumentTypeDecoration<TResult, TVariables>
{
  __apiType?: NonNullable<DocumentTypeDecoration<TResult, TVariables>['__apiType']>;
  private value: string;
  public __meta__?: Record<string, any> | undefined;

  constructor(value: string, __meta__?: Record<string, any> | undefined) {
    super(value);
    this.value = value;
    this.__meta__ = __meta__;
  }

  override toString(): string & DocumentTypeDecoration<TResult, TVariables> {
    return this.value;
  }
}
export const RoutingConfigSummaryFieldsFragmentDoc = new TypedDocumentString(`
    fragment RoutingConfigSummaryFields on RoutingConfigSummary {
  id
  name
  slug
  description
  status
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routes {
    route
    description
    targets {
      providerId
      model
      effort
      effectiveEffort
    }
  }
}
    `, {"fragmentName":"RoutingConfigSummaryFields"}) as unknown as TypedDocumentString<RoutingConfigSummaryFieldsFragment, unknown>;
export const RoutingConfigDetailFieldsFragmentDoc = new TypedDocumentString(`
    fragment RoutingConfigDetailFields on RoutingConfigDetail {
  config {
    ...RoutingConfigSummaryFields
  }
  versions {
    id
    version
    configHash
    status
    active
    createdAt
    activatedAt
    config
  }
}
    fragment RoutingConfigSummaryFields on RoutingConfigSummary {
  id
  name
  slug
  description
  status
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routes {
    route
    description
    targets {
      providerId
      model
      effort
      effectiveEffort
    }
  }
}`, {"fragmentName":"RoutingConfigDetailFields"}) as unknown as TypedDocumentString<RoutingConfigDetailFieldsFragment, unknown>;
export const ViewerFieldsFragmentDoc = new TypedDocumentString(`
    fragment ViewerFields on Viewer {
  user {
    sessionId
    organizationId
    workspaceId
    userId
    email
    name
    role
  }
  organizationId
  workspaceId
  organizations {
    id
    slug
    name
    role
  }
  workspaces {
    id
    slug
    name
  }
}
    `, {"fragmentName":"ViewerFields"}) as unknown as TypedDocumentString<ViewerFieldsFragment, unknown>;
export const SettingsViewFieldsFragmentDoc = new TypedDocumentString(`
    fragment SettingsViewFields on Settings {
  organizationId
  databaseEnabled
  subscriptionOAuthEnabled
  restartRequiredFor
  storage {
    path
    reason
  }
  settings {
    schemaVersion
    systemPrompt
    cacheTtlUpgrade
    automaticCaching
    toolResultCompressionPolicy {
      mode
      minOriginalBytes
      minSavingsTokens
      enabledRules
      storeOriginalArtifact
      storeCompressedArtifact
    }
    duplicateToolResultReferences
    costBaseline {
      anthropicMessagesModel
      openaiResponsesModel
      openaiChatModel
    }
    classifier {
      model
      timeoutMs
      maxAttempts
      allowRedactedExcerpt
    }
    routeQuality {
      lowConfidenceThreshold
    }
    promptCapture {
      promptCaptureMode
      retentionDays
    }
  }
}
    `, {"fragmentName":"SettingsViewFields"}) as unknown as TypedDocumentString<SettingsViewFieldsFragment, unknown>;
export const UsageGroupFieldsFragmentDoc = new TypedDocumentString(`
    fragment UsageGroupFields on UsageGroup {
  key
  requestCount
  failedRequests
  retriedRequests
  failureRate
  retryRate
  latency {
    averageMs
    p95Ms
  }
  usage {
    inputTokens
    cachedInputTokens
    cacheCreationInputTokens
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
    baseline
    savings
    classifier
  }
}
    `, {"fragmentName":"UsageGroupFields"}) as unknown as TypedDocumentString<UsageGroupFieldsFragment, unknown>;
export const UsageGroupCostFieldsFragmentDoc = new TypedDocumentString(`
    fragment UsageGroupCostFields on UsageGroup {
  key
  requestCount
  usage {
    inputTokens
    cachedInputTokens
    cacheCreationInputTokens
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
    baseline
    savings
    classifier
  }
}
    `, {"fragmentName":"UsageGroupCostFields"}) as unknown as TypedDocumentString<UsageGroupCostFieldsFragment, unknown>;
export const UsageGroupDashboardFieldsFragmentDoc = new TypedDocumentString(`
    fragment UsageGroupDashboardFields on UsageGroup {
  key
  requestCount
  usage {
    inputTokens
    cachedInputTokens
    cacheCreationInputTokens
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
  }
}
    `, {"fragmentName":"UsageGroupDashboardFields"}) as unknown as TypedDocumentString<UsageGroupDashboardFieldsFragment, unknown>;
export const UsageGroupChartFieldsFragmentDoc = new TypedDocumentString(`
    fragment UsageGroupChartFields on UsageGroup {
  key
  requestCount
  usage {
    inputTokens
    cachedInputTokens
    totalTokens
  }
  cost {
    selected
  }
}
    `, {"fragmentName":"UsageGroupChartFields"}) as unknown as TypedDocumentString<UsageGroupChartFieldsFragment, unknown>;
export const BillingPageDocument = new TypedDocumentString(`
    query BillingPage {
  overview {
    requestCount
    cost {
      selected
      baseline
      savings
    }
  }
}
    `) as unknown as TypedDocumentString<BillingPageQuery, BillingPageQueryVariables>;
export const TokenAttributionViewDocument = new TypedDocumentString(`
    query TokenAttributionView($start: String, $end: String) {
  tokenAttribution(start: $start, end: $end) {
    requestCount
    sampled
    buckets {
      key
      chars
      estimatedTokens
    }
    toolSchemas {
      name
      chars
      estimatedTokens
      blocks
    }
    toolResults {
      name
      chars
      estimatedTokens
      blocks
    }
    schemaChurn {
      name
      estimatedTokens
      requests
      sessions
      schemaHashes
      churningSessions
      status
    }
  }
}
    `) as unknown as TypedDocumentString<TokenAttributionViewQuery, TokenAttributionViewQueryVariables>;
export const IdleGapsViewDocument = new TypedDocumentString(`
    query IdleGapsView($start: String, $end: String) {
  idleGaps(start: $start, end: $end) {
    buckets {
      key
      label
      count
    }
    totalGaps
    overTtl
    recoverableByOneHourTtl
    estimatedRecoverableCacheReadTokens
    recommendationThresholdTokens
    recommendedTtlUpgrade
    sessionsScanned
    sampledRequests
    sampleWindowStart
    sampleWindowEnd
    sampled
  }
}
    `) as unknown as TypedDocumentString<IdleGapsViewQuery, IdleGapsViewQueryVariables>;
export const CacheBustsViewDocument = new TypedDocumentString(`
    query CacheBustsView($start: String, $end: String) {
  cacheBusts(start: $start, end: $end) {
    busts {
      sessionId
      requestId
      at
      cause
      droppedCacheReadTokens
      rebuiltTokens
      model
      gapMs
    }
    countsByCause
    sessionsScanned
    sampled
  }
}
    `) as unknown as TypedDocumentString<CacheBustsViewQuery, CacheBustsViewQueryVariables>;
export const CompressionSavingsViewDocument = new TypedDocumentString(`
    query CompressionSavingsView($start: String, $end: String) {
  compressionSavings(start: $start, end: $end) {
    eventCount
    sampled
    blocks
    savedChars
    savedEstimatedTokens
    rows {
      rule
      ruleVersion
      tool
      blocks
      savedChars
      savedEstimatedTokens
    }
  }
}
    `) as unknown as TypedDocumentString<CompressionSavingsViewQuery, CompressionSavingsViewQueryVariables>;
export const PromptCachePlansViewDocument = new TypedDocumentString(`
    query PromptCachePlansView($start: String, $end: String) {
  promptCachePlans(start: $start, end: $end) {
    totalPlans
    sampled
    plans {
      provider
      model
      mode
      count
      appliedControls
      skippedControls
    }
    controls {
      provider
      model
      mode
      control
      status
      reason
      count
    }
  }
}
    `) as unknown as TypedDocumentString<PromptCachePlansViewQuery, PromptCachePlansViewQueryVariables>;
export const PromptCachePrewarmsViewDocument = new TypedDocumentString(`
    query PromptCachePrewarmsView($start: String, $end: String) {
  promptCachePrewarms(start: $start, end: $end) {
    totalJobs
    sampled
    estimatedCostMicros
    actualCostMicros
    expiredUnusedCostMicros
    cacheReadLiftTokens
    jobs {
      provider
      model
      status
      count
      estimatedCostMicros
      actualCostMicros
      expiredUnusedCostMicros
      cacheReadLiftTokens
    }
  }
}
    `) as unknown as TypedDocumentString<PromptCachePrewarmsViewQuery, PromptCachePrewarmsViewQueryVariables>;
export const OpenAiCacheAnalyticsViewDocument = new TypedDocumentString(`
    query OpenAICacheAnalyticsView($start: String, $end: String, $interval: UsageInterval) {
  openAICacheAnalytics(start: $start, end: $end, interval: $interval) {
    interval
    totals {
      requestCount
      cachedRequests
      inputTokens
      cachedInputTokens
      cacheHitRate
      requestHitRate
    }
    groups {
      surface
      provider
      model
      route
      cacheGroupSource
      cacheGroupKey
      requestCount
      cachedRequests
      inputTokens
      cachedInputTokens
      cacheHitRate
      requestHitRate
    }
    trends {
      ts
      requestCount
      cachedRequests
      inputTokens
      cachedInputTokens
      cacheHitRate
      requestHitRate
    }
  }
}
    `) as unknown as TypedDocumentString<OpenAiCacheAnalyticsViewQuery, OpenAiCacheAnalyticsViewQueryVariables>;
export const CachePricingRatesDocument = new TypedDocumentString(`
    query CachePricingRates {
  modelPricing {
    model
    inputCostPerMtok
    cacheReadCostPerMtok
    cacheWriteCostPerMtok
  }
}
    `) as unknown as TypedDocumentString<CachePricingRatesQuery, CachePricingRatesQueryVariables>;
export const CompressionPreviewPanelDocument = new TypedDocumentString(`
    query CompressionPreviewPanel($input: CompressionPreviewInput!) {
  compressionPreview(input: $input) {
    contentAvailable
    contentRedactionReason
    blocks
    savedBytes
    savedTokens
    previewBlocks {
      blockPath
      toolName
      ruleId
      status
      skipReason
      retrievalId
      retrievalAvailable
      retrievalMarker
      originalBytes
      compressedBytes
      savedTokens
      diffSegments {
        side
        text
      }
    }
  }
}
    `) as unknown as TypedDocumentString<CompressionPreviewPanelQuery, CompressionPreviewPanelQueryVariables>;
export const InvitationsListDocument = new TypedDocumentString(`
    query InvitationsList {
  invitations {
    id
    email
    name
    role
    status
    lastSentAt
    expiresAt
    invitedBy {
      userId
      name
      email
    }
  }
}
    `) as unknown as TypedDocumentString<InvitationsListQuery, InvitationsListQueryVariables>;
export const ResendInvitationDocument = new TypedDocumentString(`
    mutation ResendInvitation($invitationId: ID!) {
  resendInvitation(invitationId: $invitationId) {
    inviteUrl
    emailDelivery {
      transport
      delivered
      error
    }
  }
}
    `) as unknown as TypedDocumentString<ResendInvitationMutation, ResendInvitationMutationVariables>;
export const RevokeInvitationDocument = new TypedDocumentString(`
    mutation RevokeInvitation($invitationId: ID!) {
  revokeInvitation(invitationId: $invitationId) {
    id
    status
  }
}
    `) as unknown as TypedDocumentString<RevokeInvitationMutation, RevokeInvitationMutationVariables>;
export const PublicInvitationDocument = new TypedDocumentString(`
    query PublicInvitation($token: String!) {
  publicInvitation(token: $token) {
    organizationName
    email
    name
    role
    status
    inviterName
    expiresAt
  }
}
    `) as unknown as TypedDocumentString<PublicInvitationQuery, PublicInvitationQueryVariables>;
export const AcceptInvitationDocument = new TypedDocumentString(`
    mutation AcceptInvitation($token: String!, $name: String) {
  acceptInvitation(token: $token, name: $name) {
    ok
    organizationId
    userId
    email
    role
  }
}
    `) as unknown as TypedDocumentString<AcceptInvitationMutation, AcceptInvitationMutationVariables>;
export const CreateInvitationDocument = new TypedDocumentString(`
    mutation CreateInvitation($input: CreateInvitationInput!) {
  createInvitation(input: $input) {
    inviteUrl
    emailDelivery {
      transport
      delivered
      error
    }
  }
}
    `) as unknown as TypedDocumentString<CreateInvitationMutation, CreateInvitationMutationVariables>;
export const KeyTrafficRequestsDocument = new TypedDocumentString(`
    query KeyTrafficRequests($start: String, $end: String, $limit: Int) {
  requests(start: $start, end: $end, limit: $limit) {
    requestId
    createdAt
    provider
    apiKeyId
    selectedModel
    terminalStatus
    selectedCost
    baselineCost
    usage {
      totalTokens
    }
  }
}
    `) as unknown as TypedDocumentString<KeyTrafficRequestsQuery, KeyTrafficRequestsQueryVariables>;
export const ModelPricingCardDocument = new TypedDocumentString(`
    query ModelPricingCard {
  modelPricing {
    model
    provider
    source
    seenInTraffic
    inputCostPerMtok
    outputCostPerMtok
    cacheReadCostPerMtok
    cacheWriteCostPerMtok
    updatedAt
  }
}
    `) as unknown as TypedDocumentString<ModelPricingCardQuery, ModelPricingCardQueryVariables>;
export const SetModelPricingDocument = new TypedDocumentString(`
    mutation SetModelPricing($input: SetModelPricingInput!) {
  setModelPricing(input: $input) {
    model
    provider
    source
    seenInTraffic
    inputCostPerMtok
    outputCostPerMtok
    cacheReadCostPerMtok
    cacheWriteCostPerMtok
    updatedAt
  }
}
    `) as unknown as TypedDocumentString<SetModelPricingMutation, SetModelPricingMutationVariables>;
export const ClearModelPricingDocument = new TypedDocumentString(`
    mutation ClearModelPricing($provider: String!, $model: String!) {
  clearModelPricing(provider: $provider, model: $model) {
    model
    provider
    source
    seenInTraffic
    inputCostPerMtok
    outputCostPerMtok
    cacheReadCostPerMtok
    cacheWriteCostPerMtok
    updatedAt
  }
}
    `) as unknown as TypedDocumentString<ClearModelPricingMutation, ClearModelPricingMutationVariables>;
export const OverviewPageDocument = new TypedDocumentString(`
    query OverviewPage {
  overviewDashboard {
    overview {
      requestCount
      totals {
        totalTokens
      }
      cost {
        selected
        baseline
        savings
      }
      routeQuality {
        lowConfidenceCount
        cheaperLikelyWouldWorkCount
        cheapCausedRetriesOrRepairsCount
      }
    }
    requests {
      createdAt
      selectedCost
      baselineCost
      usage {
        totalTokens
      }
    }
    modelUsage {
      data {
        key
        usage {
          totalTokens
        }
        cost {
          selected
        }
      }
    }
  }
}
    `) as unknown as TypedDocumentString<OverviewPageQuery, OverviewPageQueryVariables>;
export const PromptDetailViewDocument = new TypedDocumentString(`
    query PromptDetailView($artifactId: ID!) {
  prompt(artifactId: $artifactId) {
    artifact {
      artifactId
      requestId
      userId
      sessionId
      surface
      kind
      sourceIndex
      storageMode
      contentHash
      chars
      tokenEstimate
      preview
      rawText
      redactedText
      expiresAt
      finalRoute
      provider
      selectedModel
      classifier
      metadata
      createdAt
      routingConfig {
        configId
        configName
        versionId
        version
        configHash
      }
      cost {
        selected
      }
    }
    requestArtifacts {
      artifactId
      requestId
      userId
      sessionId
      surface
      kind
      sourceIndex
      storageMode
      contentHash
      chars
      tokenEstimate
      preview
      rawText
      redactedText
      expiresAt
      finalRoute
      provider
      selectedModel
      classifier
      metadata
      createdAt
      routingConfig {
        configId
        configName
        versionId
        version
        configHash
      }
      cost {
        selected
      }
    }
    routeDecisions {
      selectedProvider
      selectedModel
      classifierRoute
      finalRoute
      confidence
      routeExecutionPlan
      selectedCandidateId
      translated
      translatorId
      routingConfig {
        configId
        configName
        versionId
        version
        configHash
      }
    }
    providerAttempts {
      id
      requestId
      provider
      model
      terminalStatus
      statusCode
      error
      routeCandidateId
      attemptIndex
      fallbackIndex
      skipReason
    }
    request {
      requestId
      terminalStatus
      finalRoute
      requestedModel
      selectedModel
      provider
      latencyMs
      timeToFirstByteMs
      selectedCost
      classifier
      usage {
        inputTokens
        cachedInputTokens
        outputTokens
        reasoningTokens
        totalTokens
      }
      routingConfig {
        configId
        configName
        versionId
        version
        configHash
      }
    }
    compressionReceipts {
      id
      mode
      surface
      blockPath
      toolName
      command
      commandClass
      ruleId
      ruleVersion
      status
      skipReason
      retrievalId
      retrievalAvailable
      retrievalMarker
      originalBytes
      compressedBytes
      savedBytes
      originalTokenEstimate
      compressedTokenEstimate
      savedTokens
      estimateSource
      originalSha256
      compressedSha256
      originalArtifactId
      compressedArtifactId
      originalArtifactExpiresAt
      compressedArtifactExpiresAt
    }
    events {
      eventId
      eventType
      producer
      payload
      createdAt
    }
  }
}
    `) as unknown as TypedDocumentString<PromptDetailViewQuery, PromptDetailViewQueryVariables>;
export const PromptsListDocument = new TypedDocumentString(`
    query PromptsList {
  prompts {
    data {
      artifactId
      userId
      sessionId
      surface
      kind
      preview
      finalRoute
      selectedModel
      createdAt
      routingConfig {
        configId
        configName
        version
        configHash
      }
      cost {
        selected
      }
    }
  }
}
    `) as unknown as TypedDocumentString<PromptsListQuery, PromptsListQueryVariables>;
export const SubscriptionAuthSettingDocument = new TypedDocumentString(`
    query SubscriptionAuthSetting {
  settings {
    subscriptionOAuthEnabled
  }
}
    `) as unknown as TypedDocumentString<SubscriptionAuthSettingQuery, SubscriptionAuthSettingQueryVariables>;
export const ProviderAccountsDocument = new TypedDocumentString(`
    query ProviderAccounts {
  providerAccounts {
    id
    organizationId
    provider
    name
    authType
    status
    baseUrl
    secretHint
    credentialMode
    credentialSourceCategory
    region
    endpointOverride
    discoveryRegions
    ownerUserId
    boundKeyCount
    health {
      status
      cooldownUntil
      lastErrorType
      lastErrorAt
      lastSuccessAt
      lastCheckedAt
      consecutiveFailures
      metadata
      modelHealth {
        providerId
        providerAccountId
        model
        status
        lastErrorType
        lastErrorAt
        lockoutUntil
        consecutiveFailures
        lastSuccessAt
        metadata
      }
    }
    createdAt
    lastUsedAt
  }
}
    `) as unknown as TypedDocumentString<ProviderAccountsQuery, ProviderAccountsQueryVariables>;
export const ProviderRegistryDocument = new TypedDocumentString(`
    query ProviderRegistry {
  providers {
    id
    organizationId
    slug
    displayName
    baseUrl
    adapterKind
    authStyle
    endpoints {
      dialect
      path
      operation
    }
    defaultHeaders
    capabilities
    forwardHarnessHeaders
    enabled
    builtin
  }
}
    `) as unknown as TypedDocumentString<ProviderRegistryQuery, ProviderRegistryQueryVariables>;
export const CreateProviderCredentialDocument = new TypedDocumentString(`
    mutation CreateProviderCredential($input: CreateProviderCredentialInput!) {
  createProviderCredential(input: $input) {
    id
    name
  }
}
    `) as unknown as TypedDocumentString<CreateProviderCredentialMutation, CreateProviderCredentialMutationVariables>;
export const UpdateProviderCredentialDocument = new TypedDocumentString(`
    mutation UpdateProviderCredential($input: UpdateProviderCredentialInput!) {
  updateProviderCredential(input: $input) {
    id
    name
    credentialMode
    credentialSourceCategory
    region
    endpointOverride
    discoveryRegions
  }
}
    `) as unknown as TypedDocumentString<UpdateProviderCredentialMutation, UpdateProviderCredentialMutationVariables>;
export const CreateProviderCredentialFromLocalAuthDocument = new TypedDocumentString(`
    mutation CreateProviderCredentialFromLocalAuth($input: CreateProviderCredentialFromLocalAuthInput!) {
  createProviderCredentialFromLocalAuth(input: $input) {
    id
    name
  }
}
    `) as unknown as TypedDocumentString<CreateProviderCredentialFromLocalAuthMutation, CreateProviderCredentialFromLocalAuthMutationVariables>;
export const StartProviderCredentialOAuthDocument = new TypedDocumentString(`
    mutation StartProviderCredentialOAuth($input: StartProviderCredentialOAuthInput!) {
  startProviderCredentialOAuth(input: $input) {
    loginId
    verificationUrl
    userCode
  }
}
    `) as unknown as TypedDocumentString<StartProviderCredentialOAuthMutation, StartProviderCredentialOAuthMutationVariables>;
export const CancelProviderCredentialOAuthDocument = new TypedDocumentString(`
    mutation CancelProviderCredentialOAuth($loginId: ID!) {
  cancelProviderCredentialOAuth(loginId: $loginId) {
    loginId
    status
    providerAccountId
    error
  }
}
    `) as unknown as TypedDocumentString<CancelProviderCredentialOAuthMutation, CancelProviderCredentialOAuthMutationVariables>;
export const ProviderCredentialOAuthStatusDocument = new TypedDocumentString(`
    query ProviderCredentialOAuthStatus($loginId: ID!) {
  providerCredentialOAuthStatus(loginId: $loginId) {
    loginId
    status
    providerAccountId
    error
  }
}
    `) as unknown as TypedDocumentString<ProviderCredentialOAuthStatusQuery, ProviderCredentialOAuthStatusQueryVariables>;
export const CreateProviderDocument = new TypedDocumentString(`
    mutation CreateProvider($input: CreateProviderInput!) {
  createProvider(input: $input) {
    id
    slug
    displayName
    baseUrl
    authStyle
    enabled
    builtin
  }
}
    `) as unknown as TypedDocumentString<CreateProviderMutation, CreateProviderMutationVariables>;
export const UpdateProviderDocument = new TypedDocumentString(`
    mutation UpdateProvider($input: UpdateProviderInput!) {
  updateProvider(input: $input) {
    id
    slug
    displayName
    baseUrl
    authStyle
    enabled
    builtin
  }
}
    `) as unknown as TypedDocumentString<UpdateProviderMutation, UpdateProviderMutationVariables>;
export const DisableProviderDocument = new TypedDocumentString(`
    mutation DisableProvider($providerId: ID!) {
  disableProvider(providerId: $providerId) {
    id
    enabled
  }
}
    `) as unknown as TypedDocumentString<DisableProviderMutation, DisableProviderMutationVariables>;
export const RevokeProviderCredentialDocument = new TypedDocumentString(`
    mutation RevokeProviderCredential($providerAccountId: ID!) {
  revokeProviderCredential(providerAccountId: $providerAccountId) {
    id
    status
  }
}
    `) as unknown as TypedDocumentString<RevokeProviderCredentialMutation, RevokeProviderCredentialMutationVariables>;
export const ProbeProviderCredentialDocument = new TypedDocumentString(`
    mutation ProbeProviderCredential($input: ProbeProviderCredentialInput!) {
  probeProviderCredential(input: $input) {
    probeId
    providerAccountId
    provider
    model
    status
    healthStatus
    errorType
    message
    statusCode
    latencyMs
    checkedAt
    stateUpdated
    dimensions
  }
}
    `) as unknown as TypedDocumentString<ProbeProviderCredentialMutation, ProbeProviderCredentialMutationVariables>;
export const RefreshBedrockModelCatalogDocument = new TypedDocumentString(`
    mutation RefreshBedrockModelCatalog($input: RefreshBedrockModelCatalogInput!) {
  refreshBedrockModelCatalog(input: $input) {
    providerAccountId
    regions
    status
    error
    modelsSeen
    modelsApplied
    inserted
    updated
    skipped
    errors {
      region
      error
    }
  }
}
    `) as unknown as TypedDocumentString<RefreshBedrockModelCatalogMutation, RefreshBedrockModelCatalogMutationVariables>;
export const AssignApiKeyProviderAccountDocument = new TypedDocumentString(`
    mutation AssignApiKeyProviderAccount($apiKeyId: ID!, $provider: String!, $providerAccountId: ID) {
  assignApiKeyProviderAccount(
    apiKeyId: $apiKeyId
    provider: $provider
    providerAccountId: $providerAccountId
  ) {
    id
    providerCredentials {
      provider
      providerAccountId
      name
      status
    }
  }
}
    `) as unknown as TypedDocumentString<AssignApiKeyProviderAccountMutation, AssignApiKeyProviderAccountMutationVariables>;
export const RequestsPageDocument = new TypedDocumentString(`
    query RequestsPage($start: String, $end: String, $limit: Int) {
  prompts(start: $start, end: $end, limit: $limit) {
    data {
      artifactId
      requestId
      sessionId
      userId
      surface
      kind
      preview
      tokenEstimate
      selectedModel
      finalRoute
      provider
      createdAt
      routingConfig {
        configId
        configName
        version
        configHash
      }
      cost {
        selected
      }
    }
  }
  requests(start: $start, end: $end, limit: $limit) {
    requestId
    selectedModel
    terminalStatus
    latencyMs
    finalRoute
    provider
    selectedCandidateId
    translated
    routeSkipReasons
    apiKeyId
    sessionId
    selectedCost
    usage {
      totalTokens
    }
    routingConfig {
      configId
      configName
      version
      configHash
    }
  }
  users {
    userId
    name
    email
  }
}
    `) as unknown as TypedDocumentString<RequestsPageQuery, RequestsPageQueryVariables>;
export const RoutingConfigsListDocument = new TypedDocumentString(`
    query RoutingConfigsList {
  routingConfigs {
    ...RoutingConfigSummaryFields
    trafficShare
  }
}
    fragment RoutingConfigSummaryFields on RoutingConfigSummary {
  id
  name
  slug
  description
  status
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routes {
    route
    description
    targets {
      providerId
      model
      effort
      effectiveEffort
    }
  }
}`) as unknown as TypedDocumentString<RoutingConfigsListQuery, RoutingConfigsListQueryVariables>;
export const RoutingConfigDetailViewDocument = new TypedDocumentString(`
    query RoutingConfigDetailView($configId: ID!) {
  routingConfig(configId: $configId) {
    ...RoutingConfigDetailFields
  }
}
    fragment RoutingConfigSummaryFields on RoutingConfigSummary {
  id
  name
  slug
  description
  status
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routes {
    route
    description
    targets {
      providerId
      model
      effort
      effectiveEffort
    }
  }
}
fragment RoutingConfigDetailFields on RoutingConfigDetail {
  config {
    ...RoutingConfigSummaryFields
  }
  versions {
    id
    version
    configHash
    status
    active
    createdAt
    activatedAt
    config
  }
}`) as unknown as TypedDocumentString<RoutingConfigDetailViewQuery, RoutingConfigDetailViewQueryVariables>;
export const RoutingApiKeysDocument = new TypedDocumentString(`
    query RoutingApiKeys {
  apiKeys {
    id
    name
    userId
    routingConfigId
    createdAt
    expiresAt
    revokedAt
    lastUsedAt
    routingConfig {
      id
      name
      status
    }
    providerCredentials {
      provider
      providerAccountId
      name
      status
    }
  }
}
    `) as unknown as TypedDocumentString<RoutingApiKeysQuery, RoutingApiKeysQueryVariables>;
export const RoutingModelCatalogDocument = new TypedDocumentString(`
    query RoutingModelCatalog {
  providers {
    slug
    displayName
    authStyle
    adapterKind
    enabled
    builtin
    endpoints {
      dialect
      path
      operation
    }
    capabilities
  }
  modelCatalog {
    provider
    model
    displayName
    catalogSource
    providerAccountId
    region
    bedrockModelSource
    bedrockInferenceProfileArn
    bedrockInferenceProfileId
    bedrockInferenceProfileSource
    bedrockInferenceProfileGeography
    bedrockBaseModelId
    bedrockFoundationModelId
    dialects
    contextWindow
    maxOutputTokens
    supportsStreaming
    supportsTools
    supportsImages
    supportsReasoning
    warnings
    pricingKnown
    inputCostPerMtok
    outputCostPerMtok
  }
  providerAccounts {
    id
    providerId
    provider
    name
    status
    credentialMode
    credentialSourceCategory
    region
    endpointOverride
    discoveryRegions
    health {
      status
      lastErrorType
      cooldownUntil
      metadata
      modelHealth {
        model
        status
        lastErrorType
        lockoutUntil
        metadata
      }
    }
  }
}
    `) as unknown as TypedDocumentString<RoutingModelCatalogQuery, RoutingModelCatalogQueryVariables>;
export const CreateApiKeyDocument = new TypedDocumentString(`
    mutation CreateApiKey($input: CreateApiKeyInput!) {
  createApiKey(input: $input) {
    apiKey {
      id
      name
    }
    secret
  }
}
    `) as unknown as TypedDocumentString<CreateApiKeyMutation, CreateApiKeyMutationVariables>;
export const RevokeApiKeyDocument = new TypedDocumentString(`
    mutation RevokeApiKey($apiKeyId: ID!) {
  revokeApiKey(apiKeyId: $apiKeyId) {
    id
    revokedAt
  }
}
    `) as unknown as TypedDocumentString<RevokeApiKeyMutation, RevokeApiKeyMutationVariables>;
export const ApiKeyVerificationDocument = new TypedDocumentString(`
    query ApiKeyVerification($apiKeyId: ID!) {
  apiKey(apiKeyId: $apiKeyId) {
    id
    lastUsedAt
  }
}
    `) as unknown as TypedDocumentString<ApiKeyVerificationQuery, ApiKeyVerificationQueryVariables>;
export const CreateRoutingConfigDocument = new TypedDocumentString(`
    mutation CreateRoutingConfig($input: CreateRoutingConfigInput!) {
  createRoutingConfig(input: $input) {
    ...RoutingConfigDetailFields
  }
}
    fragment RoutingConfigSummaryFields on RoutingConfigSummary {
  id
  name
  slug
  description
  status
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routes {
    route
    description
    targets {
      providerId
      model
      effort
      effectiveEffort
    }
  }
}
fragment RoutingConfigDetailFields on RoutingConfigDetail {
  config {
    ...RoutingConfigSummaryFields
  }
  versions {
    id
    version
    configHash
    status
    active
    createdAt
    activatedAt
    config
  }
}`) as unknown as TypedDocumentString<CreateRoutingConfigMutation, CreateRoutingConfigMutationVariables>;
export const CreateRoutingConfigVersionDocument = new TypedDocumentString(`
    mutation CreateRoutingConfigVersion($configId: ID!, $config: JSON!) {
  createRoutingConfigVersion(configId: $configId, config: $config) {
    ...RoutingConfigDetailFields
  }
}
    fragment RoutingConfigSummaryFields on RoutingConfigSummary {
  id
  name
  slug
  description
  status
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routes {
    route
    description
    targets {
      providerId
      model
      effort
      effectiveEffort
    }
  }
}
fragment RoutingConfigDetailFields on RoutingConfigDetail {
  config {
    ...RoutingConfigSummaryFields
  }
  versions {
    id
    version
    configHash
    status
    active
    createdAt
    activatedAt
    config
  }
}`) as unknown as TypedDocumentString<CreateRoutingConfigVersionMutation, CreateRoutingConfigVersionMutationVariables>;
export const ActivateRoutingConfigVersionDocument = new TypedDocumentString(`
    mutation ActivateRoutingConfigVersion($configId: ID!, $versionId: ID!) {
  activateRoutingConfigVersion(configId: $configId, versionId: $versionId) {
    ...RoutingConfigDetailFields
  }
}
    fragment RoutingConfigSummaryFields on RoutingConfigSummary {
  id
  name
  slug
  description
  status
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routes {
    route
    description
    targets {
      providerId
      model
      effort
      effectiveEffort
    }
  }
}
fragment RoutingConfigDetailFields on RoutingConfigDetail {
  config {
    ...RoutingConfigSummaryFields
  }
  versions {
    id
    version
    configHash
    status
    active
    createdAt
    activatedAt
    config
  }
}`) as unknown as TypedDocumentString<ActivateRoutingConfigVersionMutation, ActivateRoutingConfigVersionMutationVariables>;
export const ArchiveRoutingConfigDocument = new TypedDocumentString(`
    mutation ArchiveRoutingConfig($configId: ID!) {
  archiveRoutingConfig(configId: $configId) {
    ...RoutingConfigDetailFields
  }
}
    fragment RoutingConfigSummaryFields on RoutingConfigSummary {
  id
  name
  slug
  description
  status
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routes {
    route
    description
    targets {
      providerId
      model
      effort
      effectiveEffort
    }
  }
}
fragment RoutingConfigDetailFields on RoutingConfigDetail {
  config {
    ...RoutingConfigSummaryFields
  }
  versions {
    id
    version
    configHash
    status
    active
    createdAt
    activatedAt
    config
  }
}`) as unknown as TypedDocumentString<ArchiveRoutingConfigMutation, ArchiveRoutingConfigMutationVariables>;
export const AssignRoutingConfigKeyDocument = new TypedDocumentString(`
    mutation AssignRoutingConfigKey($apiKeyId: ID!, $routingConfigId: ID) {
  assignApiKeyRoutingConfig(
    apiKeyId: $apiKeyId
    routingConfigId: $routingConfigId
  ) {
    id
    routingConfigId
  }
}
    `) as unknown as TypedDocumentString<AssignRoutingConfigKeyMutation, AssignRoutingConfigKeyMutationVariables>;
export const GlobalSearchDocument = new TypedDocumentString(`
    query GlobalSearch($query: String!) {
  search(query: $query) {
    results {
      kind
      id
      title
      subtitle
      status
      snippet
      occurredAt
    }
  }
}
    `) as unknown as TypedDocumentString<GlobalSearchQuery, GlobalSearchQueryVariables>;
export const ViewerDocument = new TypedDocumentString(`
    query Viewer {
  viewer {
    ...ViewerFields
  }
}
    fragment ViewerFields on Viewer {
  user {
    sessionId
    organizationId
    workspaceId
    userId
    email
    name
    role
  }
  organizationId
  workspaceId
  organizations {
    id
    slug
    name
    role
  }
  workspaces {
    id
    slug
    name
  }
}`) as unknown as TypedDocumentString<ViewerQuery, ViewerQueryVariables>;
export const LoginDocument = new TypedDocumentString(`
    mutation Login($email: String!, $password: String!) {
  login(email: $email, password: $password) {
    ...ViewerFields
  }
}
    fragment ViewerFields on Viewer {
  user {
    sessionId
    organizationId
    workspaceId
    userId
    email
    name
    role
  }
  organizationId
  workspaceId
  organizations {
    id
    slug
    name
    role
  }
  workspaces {
    id
    slug
    name
  }
}`) as unknown as TypedDocumentString<LoginMutation, LoginMutationVariables>;
export const LogoutDocument = new TypedDocumentString(`
    mutation Logout {
  logout
}
    `) as unknown as TypedDocumentString<LogoutMutation, LogoutMutationVariables>;
export const SwitchOrganizationDocument = new TypedDocumentString(`
    mutation SwitchOrganization($organizationId: ID!) {
  switchOrganization(organizationId: $organizationId) {
    ...ViewerFields
  }
}
    fragment ViewerFields on Viewer {
  user {
    sessionId
    organizationId
    workspaceId
    userId
    email
    name
    role
  }
  organizationId
  workspaceId
  organizations {
    id
    slug
    name
    role
  }
  workspaces {
    id
    slug
    name
  }
}`) as unknown as TypedDocumentString<SwitchOrganizationMutation, SwitchOrganizationMutationVariables>;
export const SwitchWorkspaceDocument = new TypedDocumentString(`
    mutation SwitchWorkspace($workspaceId: ID!) {
  switchWorkspace(workspaceId: $workspaceId) {
    ...ViewerFields
  }
}
    fragment ViewerFields on Viewer {
  user {
    sessionId
    organizationId
    workspaceId
    userId
    email
    name
    role
  }
  organizationId
  workspaceId
  organizations {
    id
    slug
    name
    role
  }
  workspaces {
    id
    slug
    name
  }
}`) as unknown as TypedDocumentString<SwitchWorkspaceMutation, SwitchWorkspaceMutationVariables>;
export const CreateWorkspaceDocument = new TypedDocumentString(`
    mutation CreateWorkspace($input: CreateWorkspaceInput!) {
  createWorkspace(input: $input) {
    id
    slug
    name
  }
}
    `) as unknown as TypedDocumentString<CreateWorkspaceMutation, CreateWorkspaceMutationVariables>;
export const SessionDetailViewDocument = new TypedDocumentString(`
    query SessionDetailView($sessionId: ID!) {
  session(sessionId: $sessionId) {
    session {
      sessionId
      externalSessionId
      userId
      surface
      sessionIdentity
      requestCount
      startedAt
      usage {
        inputTokens
        outputTokens
      }
      cost {
        selected
      }
    }
    user
    requests {
      requestId
      createdAt
      selectedModel
      finalRoute
      terminalStatus
      latencyMs
      selectedCost
      usage {
        inputTokens
        cachedInputTokens
        outputTokens
        totalTokens
      }
    }
    promptArtifacts {
      artifactId
      requestId
      kind
      sourceIndex
      contentHash
      chars
      createdAt
      preview
      tokenEstimate
      metadata
    }
  }
}
    `) as unknown as TypedDocumentString<SessionDetailViewQuery, SessionDetailViewQueryVariables>;
export const SessionsPageDocument = new TypedDocumentString(`
    query SessionsPage {
  sessions {
    sessionId
    externalSessionId
    userId
    surface
    currentRoute
    requestCount
    startedAt
    endedAt
    recentActivity
    modelMix
    routeMix
    terminalStatusSummary
    usage {
      totalTokens
    }
    cost {
      selected
    }
  }
  users {
    userId
    name
    email
  }
}
    `) as unknown as TypedDocumentString<SessionsPageQuery, SessionsPageQueryVariables>;
export const SettingsViewDocument = new TypedDocumentString(`
    query SettingsView {
  settings {
    ...SettingsViewFields
  }
}
    fragment SettingsViewFields on Settings {
  organizationId
  databaseEnabled
  subscriptionOAuthEnabled
  restartRequiredFor
  storage {
    path
    reason
  }
  settings {
    schemaVersion
    systemPrompt
    cacheTtlUpgrade
    automaticCaching
    toolResultCompressionPolicy {
      mode
      minOriginalBytes
      minSavingsTokens
      enabledRules
      storeOriginalArtifact
      storeCompressedArtifact
    }
    duplicateToolResultReferences
    costBaseline {
      anthropicMessagesModel
      openaiResponsesModel
      openaiChatModel
    }
    classifier {
      model
      timeoutMs
      maxAttempts
      allowRedactedExcerpt
    }
    routeQuality {
      lowConfidenceThreshold
    }
    promptCapture {
      promptCaptureMode
      retentionDays
    }
  }
}`) as unknown as TypedDocumentString<SettingsViewQuery, SettingsViewQueryVariables>;
export const UpdateSettingsDocument = new TypedDocumentString(`
    mutation UpdateSettings($input: SettingsInput!) {
  updateSettings(input: $input) {
    ...SettingsViewFields
  }
}
    fragment SettingsViewFields on Settings {
  organizationId
  databaseEnabled
  subscriptionOAuthEnabled
  restartRequiredFor
  storage {
    path
    reason
  }
  settings {
    schemaVersion
    systemPrompt
    cacheTtlUpgrade
    automaticCaching
    toolResultCompressionPolicy {
      mode
      minOriginalBytes
      minSavingsTokens
      enabledRules
      storeOriginalArtifact
      storeCompressedArtifact
    }
    duplicateToolResultReferences
    costBaseline {
      anthropicMessagesModel
      openaiResponsesModel
      openaiChatModel
    }
    classifier {
      model
      timeoutMs
      maxAttempts
      allowRedactedExcerpt
    }
    routeQuality {
      lowConfidenceThreshold
    }
    promptCapture {
      promptCaptureMode
      retentionDays
    }
  }
}`) as unknown as TypedDocumentString<UpdateSettingsMutation, UpdateSettingsMutationVariables>;
export const UsageReportViewDocument = new TypedDocumentString(`
    query UsageReportView($groupBy: UsageGroupBy!, $start: String, $end: String) {
  usage(groupBy: $groupBy, start: $start, end: $end) {
    groupBy
    data {
      ...UsageGroupFields
    }
    totals {
      ...UsageGroupFields
    }
  }
}
    fragment UsageGroupFields on UsageGroup {
  key
  requestCount
  failedRequests
  retriedRequests
  failureRate
  retryRate
  latency {
    averageMs
    p95Ms
  }
  usage {
    inputTokens
    cachedInputTokens
    cacheCreationInputTokens
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
    baseline
    savings
    classifier
  }
}`) as unknown as TypedDocumentString<UsageReportViewQuery, UsageReportViewQueryVariables>;
export const UsageTimeseriesViewDocument = new TypedDocumentString(`
    query UsageTimeseriesView($groupBy: UsageGroupBy!, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {
  usageTimeseries(
    groupBy: $groupBy
    interval: $interval
    start: $start
    end: $end
    limit: $limit
  ) {
    groupBy
    interval
    start
    end
    groups {
      ...UsageGroupFields
    }
    points {
      ts
      totals {
        ...UsageGroupFields
      }
      groups
    }
  }
}
    fragment UsageGroupFields on UsageGroup {
  key
  requestCount
  failedRequests
  retriedRequests
  failureRate
  retryRate
  latency {
    averageMs
    p95Ms
  }
  usage {
    inputTokens
    cachedInputTokens
    cacheCreationInputTokens
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
    baseline
    savings
    classifier
  }
}`) as unknown as TypedDocumentString<UsageTimeseriesViewQuery, UsageTimeseriesViewQueryVariables>;
export const UsageDashboardViewDocument = new TypedDocumentString(`
    query UsageDashboardView($groupBy: UsageGroupBy!, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {
  usageDashboard(
    groupBy: $groupBy
    interval: $interval
    start: $start
    end: $end
    limit: $limit
  ) {
    usage {
      groupBy
      data {
        ...UsageGroupDashboardFields
      }
      totals {
        ...UsageGroupDashboardFields
      }
    }
    timeseries {
      groupBy
      interval
      start
      end
      groups {
        ...UsageGroupChartFields
      }
      points {
        ts
        totals {
          ...UsageGroupChartFields
        }
        groups
      }
    }
  }
}
    fragment UsageGroupDashboardFields on UsageGroup {
  key
  requestCount
  usage {
    inputTokens
    cachedInputTokens
    cacheCreationInputTokens
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
  }
}
fragment UsageGroupChartFields on UsageGroup {
  key
  requestCount
  usage {
    inputTokens
    cachedInputTokens
    totalTokens
  }
  cost {
    selected
  }
}`) as unknown as TypedDocumentString<UsageDashboardViewQuery, UsageDashboardViewQueryVariables>;
export const UsageCostDashboardViewDocument = new TypedDocumentString(`
    query UsageCostDashboardView($groupBy: UsageGroupBy!, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {
  usageDashboard(
    groupBy: $groupBy
    interval: $interval
    start: $start
    end: $end
    limit: $limit
  ) {
    usage {
      groupBy
      data {
        ...UsageGroupCostFields
      }
      totals {
        ...UsageGroupCostFields
      }
    }
    timeseries {
      groupBy
      interval
      start
      end
      groups {
        ...UsageGroupChartFields
      }
      points {
        ts
        totals {
          ...UsageGroupChartFields
        }
        groups
      }
    }
  }
}
    fragment UsageGroupCostFields on UsageGroup {
  key
  requestCount
  usage {
    inputTokens
    cachedInputTokens
    cacheCreationInputTokens
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
    baseline
    savings
    classifier
  }
}
fragment UsageGroupChartFields on UsageGroup {
  key
  requestCount
  usage {
    inputTokens
    cachedInputTokens
    totalTokens
  }
  cost {
    selected
  }
}`) as unknown as TypedDocumentString<UsageCostDashboardViewQuery, UsageCostDashboardViewQueryVariables>;
export const UsageLookupsDocument = new TypedDocumentString(`
    query UsageLookups {
  members {
    userId
    name
    email
  }
  apiKeys {
    id
    name
    revokedAt
  }
}
    `) as unknown as TypedDocumentString<UsageLookupsQuery, UsageLookupsQueryVariables>;
export const RouteOutputViewDocument = new TypedDocumentString(`
    query RouteOutputView($start: String, $end: String) {
  routeOutputReport(start: $start, end: $end) {
    routes {
      route
      requests
      outputTokens
      reasoningTokens
      avgOutputTokens
      reasoningShare
      outputCost
    }
    models {
      key
      requests
      outputTokens
      reasoningTokens
      avgOutputTokens
      reasoningShare
      outputCost
    }
    users {
      key
      requests
      outputTokens
      reasoningTokens
      avgOutputTokens
      reasoningShare
      outputCost
    }
    apiKeys {
      key
      requests
      outputTokens
      reasoningTokens
      avgOutputTokens
      reasoningShare
      outputCost
    }
    workspaces {
      key
      requests
      outputTokens
      reasoningTokens
      avgOutputTokens
      reasoningShare
      outputCost
    }
  }
}
    `) as unknown as TypedDocumentString<RouteOutputViewQuery, RouteOutputViewQueryVariables>;
export const UnpricedModelsDocument = new TypedDocumentString(`
    query UnpricedModels {
  modelPricing {
    model
    provider
    source
    seenInTraffic
  }
}
    `) as unknown as TypedDocumentString<UnpricedModelsQuery, UnpricedModelsQueryVariables>;
export const UserDirectoryDocument = new TypedDocumentString(`
    query UserDirectory {
  users {
    userId
    name
    email
  }
}
    `) as unknown as TypedDocumentString<UserDirectoryQuery, UserDirectoryQueryVariables>;
export const DeactivateUserDocument = new TypedDocumentString(`
    mutation DeactivateUser($userId: ID!) {
  deactivateUser(userId: $userId) {
    userId
    status
  }
}
    `) as unknown as TypedDocumentString<DeactivateUserMutation, DeactivateUserMutationVariables>;
export const ReactivateUserDocument = new TypedDocumentString(`
    mutation ReactivateUser($userId: ID!) {
  reactivateUser(userId: $userId) {
    userId
    status
  }
}
    `) as unknown as TypedDocumentString<ReactivateUserMutation, ReactivateUserMutationVariables>;
export const UsersListDocument = new TypedDocumentString(`
    query UsersList {
  users {
    userId
    email
    name
    externalId
    membership {
      role
      status
    }
    apiKeyCount
    requestCount
    sessionCount
    usage {
      totalTokens
    }
    cost {
      selected
    }
    usage30d {
      totalTokens
    }
    cost30d {
      selected
    }
    recentActivity
    createdAt
  }
}
    `) as unknown as TypedDocumentString<UsersListQuery, UsersListQueryVariables>;
export const UpdateUserRoleDocument = new TypedDocumentString(`
    mutation UpdateUserRole($userId: ID!, $role: MemberRole!) {
  updateUserRole(userId: $userId, role: $role) {
    userId
    role
    previousRole
  }
}
    `) as unknown as TypedDocumentString<UpdateUserRoleMutation, UpdateUserRoleMutationVariables>;