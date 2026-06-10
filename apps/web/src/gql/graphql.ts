/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import { DocumentTypeDecoration } from '@graphql-typed-document-node/core';
export type BudgetSettingsInput = {
  maxEstimatedInputTokens?: number | null | undefined;
  maxRoute?: string | null | undefined;
  warningEstimatedInputTokens?: number | null | undefined;
};

export type ClassifierSettingsInput = {
  allowRedactedExcerpt?: boolean | null | undefined;
  maxAttempts?: number | null | undefined;
  model?: string | null | undefined;
  timeoutMs?: number | null | undefined;
};

export type CreateApiKeyInput = {
  name: string;
  routingConfigId?: string | number | null | undefined;
  scopes?: Array<string> | null | undefined;
};

export type CreateInvitationInput = {
  email: string;
  name?: string | null | undefined;
  role: MemberRole;
};

export type CreateProviderCredentialInput = {
  apiKey: string;
  name: string;
  provider: string;
};

export type CreateRoutingConfigInput = {
  config: unknown;
  description?: string | null | undefined;
  name: string;
  slug: string;
};

export type MemberRole =
  | 'admin'
  | 'member'
  | 'owner'
  | 'viewer';

export type PromptCaptureSettingsInput = {
  promptCaptureMode?: string | null | undefined;
  retentionDays?: number | null | undefined;
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

export type SettingsInput = {
  budgets?: BudgetSettingsInput | null | undefined;
  classifier?: ClassifierSettingsInput | null | undefined;
  promptCapture?: PromptCaptureSettingsInput | null | undefined;
  routeQuality?: RouteQualitySettingsInput | null | undefined;
  schemaVersion?: number | null | undefined;
};

export type UsageGroupBy =
  | 'api_key'
  | 'model'
  | 'provider'
  | 'route'
  | 'session'
  | 'surface'
  | 'user';

export type UsageInterval =
  | 'day'
  | 'hour';

export type BillingPageQueryVariables = Exact<{ [key: string]: never; }>;


export type BillingPageQuery = { overview: { requestCount: number, cost: { selected: number, baseline: number, savings: number } }, settings: { budgets: { warningEstimatedInputTokens: number | null, maxEstimatedInputTokens: number | null, maxRoute: string | null } } };

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

export type OverviewPageQueryVariables = Exact<{ [key: string]: never; }>;


export type OverviewPageQuery = { overview: { requestCount: number, totals: { totalTokens: number }, cost: { selected: number, baseline: number, savings: number }, routeQuality: { lowConfidenceCount: number, cheaperLikelyWouldWorkCount: number, cheapCausedRetriesOrRepairsCount: number } }, requests: Array<{ createdAt: string | null, selectedCost: number, baselineCost: number, usage: { totalTokens: number } }>, modelUsage: { data: Array<{ key: string, usage: { totalTokens: number }, cost: { selected: number } }> } };

export type PromptDetailViewQueryVariables = Exact<{
  artifactId: string | number;
}>;


export type PromptDetailViewQuery = { prompt: { artifact: { artifactId: string, requestId: string, userId: string | null, sessionId: string | null, surface: string, kind: string, storageMode: string, contentHash: string, chars: number | null, tokenEstimate: number | null, preview: string | null, rawText: string | null, redactedText: string | null, expiresAt: string | null, finalRoute: string | null, provider: string | null, selectedModel: string | null, classifier: unknown, createdAt: string, routingConfig: { configId: string, configName: string | null, versionId: string | null, version: number | null, configHash: string | null } | null, cost: { selected: number } }, requestArtifacts: Array<{ artifactId: string, requestId: string, userId: string | null, sessionId: string | null, surface: string, kind: string, storageMode: string, contentHash: string, chars: number | null, tokenEstimate: number | null, preview: string | null, rawText: string | null, redactedText: string | null, expiresAt: string | null, finalRoute: string | null, provider: string | null, selectedModel: string | null, classifier: unknown, createdAt: string, routingConfig: { configId: string, configName: string | null, versionId: string | null, version: number | null, configHash: string | null } | null, cost: { selected: number } }>, request: { requestId: string, terminalStatus: string, finalRoute: string | null, requestedModel: string | null, selectedModel: string | null, provider: string | null, latencyMs: number | null, timeToFirstByteMs: number | null, selectedCost: number, classifier: unknown, usage: { inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, routingConfig: { configId: string, configName: string | null, versionId: string | null, version: number | null, configHash: string | null } | null } | null, events: Array<{ eventId: string, eventType: string, producer: string, payload: unknown, createdAt: string }> } | null };

export type PromptsListQueryVariables = Exact<{ [key: string]: never; }>;


export type PromptsListQuery = { prompts: { data: Array<{ artifactId: string, userId: string | null, sessionId: string | null, surface: string, kind: string, preview: string | null, finalRoute: string | null, selectedModel: string | null, createdAt: string, routingConfig: { configId: string, configName: string | null, version: number | null, configHash: string | null } | null, cost: { selected: number } }> } };

export type ProviderAccountsQueryVariables = Exact<{ [key: string]: never; }>;


export type ProviderAccountsQuery = { providerAccounts: Array<{ id: string, organizationId: string, provider: string, name: string, authType: string, status: string, secretHint: string | null, ownerUserId: string | null, boundKeyCount: number, createdAt: string, lastUsedAt: string | null }> };

export type CreateProviderCredentialMutationVariables = Exact<{
  input: CreateProviderCredentialInput;
}>;


export type CreateProviderCredentialMutation = { createProviderCredential: { id: string, name: string } | null };

export type RevokeProviderCredentialMutationVariables = Exact<{
  providerAccountId: string | number;
}>;


export type RevokeProviderCredentialMutation = { revokeProviderCredential: { id: string, status: string } | null };

export type AssignApiKeyProviderAccountMutationVariables = Exact<{
  apiKeyId: string | number;
  provider: string;
  providerAccountId?: string | number | null | undefined;
}>;


export type AssignApiKeyProviderAccountMutation = { assignApiKeyProviderAccount: { id: string, providerCredentials: Array<{ provider: string, providerAccountId: string, name: string | null, status: string | null }> } };

export type RequestsPageQueryVariables = Exact<{ [key: string]: never; }>;


export type RequestsPageQuery = { prompts: { data: Array<{ artifactId: string, requestId: string, sessionId: string | null, userId: string | null, surface: string, kind: string, preview: string | null, tokenEstimate: number | null, selectedModel: string | null, finalRoute: string | null, routingConfig: { configId: string, configName: string | null, version: number | null, configHash: string | null } | null, cost: { selected: number } }> }, requests: Array<{ requestId: string, selectedModel: string | null, terminalStatus: string, latencyMs: number | null, finalRoute: string | null, selectedCost: number, usage: { totalTokens: number }, routingConfig: { configId: string, configName: string | null, version: number | null, configHash: string | null } | null }>, users: Array<{ userId: string, name: string | null, email: string | null }> };

export type RoutingConfigSummaryFieldsFragment = { id: string, name: string, slug: string, description: string | null, status: string, systemPrompt: string | null, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routeMatrix: Array<{ route: string, description: string | null, openaiModel: string | null, openaiEffort: string | null, anthropicModel: string | null, anthropicEffort: string | null }> };

export type RoutingConfigDetailFieldsFragment = { config: { id: string, name: string, slug: string, description: string | null, status: string, systemPrompt: string | null, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routeMatrix: Array<{ route: string, description: string | null, openaiModel: string | null, openaiEffort: string | null, anthropicModel: string | null, anthropicEffort: string | null }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> };

export type RoutingConfigsListQueryVariables = Exact<{ [key: string]: never; }>;


export type RoutingConfigsListQuery = { routingConfigs: Array<{ id: string, name: string, slug: string, description: string | null, status: string, systemPrompt: string | null, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routeMatrix: Array<{ route: string, description: string | null, openaiModel: string | null, openaiEffort: string | null, anthropicModel: string | null, anthropicEffort: string | null }> }> };

export type RoutingConfigDetailViewQueryVariables = Exact<{
  configId: string | number;
}>;


export type RoutingConfigDetailViewQuery = { routingConfig: { config: { id: string, name: string, slug: string, description: string | null, status: string, systemPrompt: string | null, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routeMatrix: Array<{ route: string, description: string | null, openaiModel: string | null, openaiEffort: string | null, anthropicModel: string | null, anthropicEffort: string | null }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } | null };

export type RoutingApiKeysQueryVariables = Exact<{ [key: string]: never; }>;


export type RoutingApiKeysQuery = { apiKeys: Array<{ id: string, name: string, userId: string | null, scopes: Array<string>, routingConfigId: string | null, createdAt: string, expiresAt: string | null, revokedAt: string | null, lastUsedAt: string | null, routingConfig: { id: string, name: string | null, status: string | null } | null, providerCredentials: Array<{ provider: string, providerAccountId: string, name: string | null, status: string | null }> }> };

export type CreateApiKeyMutationVariables = Exact<{
  input: CreateApiKeyInput;
}>;


export type CreateApiKeyMutation = { createApiKey: { secret: string, apiKey: { id: string, name: string } | null } };

export type RevokeApiKeyMutationVariables = Exact<{
  apiKeyId: string | number;
}>;


export type RevokeApiKeyMutation = { revokeApiKey: { id: string, revokedAt: string | null } };

export type CreateRoutingConfigMutationVariables = Exact<{
  input: CreateRoutingConfigInput;
}>;


export type CreateRoutingConfigMutation = { createRoutingConfig: { config: { id: string, name: string, slug: string, description: string | null, status: string, systemPrompt: string | null, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routeMatrix: Array<{ route: string, description: string | null, openaiModel: string | null, openaiEffort: string | null, anthropicModel: string | null, anthropicEffort: string | null }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } };

export type CreateRoutingConfigVersionMutationVariables = Exact<{
  configId: string | number;
  config: unknown;
}>;


export type CreateRoutingConfigVersionMutation = { createRoutingConfigVersion: { config: { id: string, name: string, slug: string, description: string | null, status: string, systemPrompt: string | null, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routeMatrix: Array<{ route: string, description: string | null, openaiModel: string | null, openaiEffort: string | null, anthropicModel: string | null, anthropicEffort: string | null }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } };

export type ActivateRoutingConfigVersionMutationVariables = Exact<{
  configId: string | number;
  versionId: string | number;
}>;


export type ActivateRoutingConfigVersionMutation = { activateRoutingConfigVersion: { config: { id: string, name: string, slug: string, description: string | null, status: string, systemPrompt: string | null, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routeMatrix: Array<{ route: string, description: string | null, openaiModel: string | null, openaiEffort: string | null, anthropicModel: string | null, anthropicEffort: string | null }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } };

export type ArchiveRoutingConfigMutationVariables = Exact<{
  configId: string | number;
}>;


export type ArchiveRoutingConfigMutation = { archiveRoutingConfig: { config: { id: string, name: string, slug: string, description: string | null, status: string, systemPrompt: string | null, activeVersionId: string | null, assignedApiKeyCount: number, updatedAt: string, activeVersion: { id: string, version: number, configHash: string } | null, routeMatrix: Array<{ route: string, description: string | null, openaiModel: string | null, openaiEffort: string | null, anthropicModel: string | null, anthropicEffort: string | null }> }, versions: Array<{ id: string, version: number, configHash: string, status: string, active: boolean, createdAt: string, activatedAt: string | null, config: unknown }> } };

export type AssignRoutingConfigKeyMutationVariables = Exact<{
  apiKeyId: string | number;
  routingConfigId?: string | number | null | undefined;
}>;


export type AssignRoutingConfigKeyMutation = { assignApiKeyRoutingConfig: { id: string, routingConfigId: string | null } };

export type GlobalSearchQueryVariables = Exact<{
  query: string;
}>;


export type GlobalSearchQuery = { search: { results: Array<{ kind: SearchHitKind, id: string, title: string, subtitle: string | null, status: string | null, snippet: string | null, occurredAt: string | null }> } };

export type ViewerFieldsFragment = { organizationId: string, user: { sessionId: string, organizationId: string, userId: string, email: string | null, name: string | null, role: string }, organizations: Array<{ id: string, slug: string, name: string, role: string }> };

export type ViewerQueryVariables = Exact<{ [key: string]: never; }>;


export type ViewerQuery = { viewer: { organizationId: string, user: { sessionId: string, organizationId: string, userId: string, email: string | null, name: string | null, role: string }, organizations: Array<{ id: string, slug: string, name: string, role: string }> } };

export type LoginMutationVariables = Exact<{
  email: string;
  password: string;
}>;


export type LoginMutation = { login: { organizationId: string, user: { sessionId: string, organizationId: string, userId: string, email: string | null, name: string | null, role: string }, organizations: Array<{ id: string, slug: string, name: string, role: string }> } };

export type LogoutMutationVariables = Exact<{ [key: string]: never; }>;


export type LogoutMutation = { logout: boolean };

export type SwitchOrganizationMutationVariables = Exact<{
  organizationId: string | number;
}>;


export type SwitchOrganizationMutation = { switchOrganization: { organizationId: string, user: { sessionId: string, organizationId: string, userId: string, email: string | null, name: string | null, role: string }, organizations: Array<{ id: string, slug: string, name: string, role: string }> } };

export type SessionsPageQueryVariables = Exact<{ [key: string]: never; }>;


export type SessionsPageQuery = { sessions: Array<{ sessionId: string, externalSessionId: string | null, userId: string | null, surface: string, currentRoute: string | null, requestCount: number, startedAt: string, recentActivity: string | null, modelMix: unknown, routeMix: unknown, terminalStatusSummary: unknown, usage: { totalTokens: number }, cost: { selected: number } }>, users: Array<{ userId: string, name: string | null, email: string | null }> };

export type SessionDetailViewQueryVariables = Exact<{
  sessionId: string | number;
}>;


export type SessionDetailViewQuery = { session: { user: unknown, session: { sessionId: string, externalSessionId: string | null, userId: string | null, surface: string, sessionIdentity: string | null, requestCount: number, startedAt: string, recentActivity: string | null, modelMix: unknown, routeMix: unknown, usage: { totalTokens: number }, cost: { selected: number } }, requests: Array<{ requestId: string, createdAt: string | null, selectedModel: string | null, finalRoute: string | null, terminalStatus: string, selectedCost: number, usage: { totalTokens: number } }>, promptArtifacts: Array<{ artifactId: string, requestId: string, kind: string, rawText: string | null, redactedText: string | null, preview: string | null }> } | null };

export type SettingsViewQueryVariables = Exact<{ [key: string]: never; }>;


export type SettingsViewQuery = { settings: { organizationId: string, databaseEnabled: boolean, restartRequiredFor: Array<string>, storage: { path: string, reason: string }, settings: { schemaVersion: number, classifier: { model: string, timeoutMs: number, maxAttempts: number, allowRedactedExcerpt: boolean }, budgets: { warningEstimatedInputTokens: number | null, maxEstimatedInputTokens: number | null, maxRoute: string | null }, routeQuality: { lowConfidenceThreshold: number }, promptCapture: { promptCaptureMode: string, retentionDays: number } } } };

export type UpdateSettingsMutationVariables = Exact<{
  input: SettingsInput;
}>;


export type UpdateSettingsMutation = { updateSettings: { organizationId: string, databaseEnabled: boolean, restartRequiredFor: Array<string>, storage: { path: string, reason: string }, settings: { schemaVersion: number, classifier: { model: string, timeoutMs: number, maxAttempts: number, allowRedactedExcerpt: boolean }, budgets: { warningEstimatedInputTokens: number | null, maxEstimatedInputTokens: number | null, maxRoute: string | null }, routeQuality: { lowConfidenceThreshold: number }, promptCapture: { promptCaptureMode: string, retentionDays: number } } } };

export type UsageGroupFieldsFragment = { key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number } };

export type UsageReportViewQueryVariables = Exact<{
  groupBy: UsageGroupBy;
  start?: string | null | undefined;
  end?: string | null | undefined;
}>;


export type UsageReportViewQuery = { usage: { groupBy: UsageGroupBy, data: Array<{ key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number } }>, totals: { key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number } } } };

export type UsageTimeseriesViewQueryVariables = Exact<{
  groupBy: UsageGroupBy;
  interval?: UsageInterval | null | undefined;
  start?: string | null | undefined;
  end?: string | null | undefined;
  limit?: number | null | undefined;
}>;


export type UsageTimeseriesViewQuery = { usageTimeseries: { groupBy: UsageGroupBy, interval: UsageInterval, start: string, end: string, groups: Array<{ key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number } }>, points: Array<{ ts: string, groups: unknown, totals: { key: string, requestCount: number, failedRequests: number, retriedRequests: number, failureRate: number, retryRate: number, latency: { averageMs: number | null, p95Ms: number | null }, usage: { inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningTokens: number, totalTokens: number }, cost: { selected: number, baseline: number, savings: number } } }> } };

export type UsageLookupsQueryVariables = Exact<{ [key: string]: never; }>;


export type UsageLookupsQuery = { members: Array<{ userId: string, name: string | null, email: string | null }>, apiKeys: Array<{ id: string, name: string, revokedAt: string | null }> };

export type UsersListQueryVariables = Exact<{ [key: string]: never; }>;


export type UsersListQuery = { users: Array<{ userId: string, email: string | null, name: string | null, externalId: string | null, requestCount: number, sessionCount: number, recentActivity: string | null, createdAt: string, membership: { role: string, status: string } | null, usage: { totalTokens: number }, cost: { selected: number } }> };

export type UpdateUserRoleMutationVariables = Exact<{
  userId: string | number;
  role: MemberRole;
}>;


export type UpdateUserRoleMutation = { updateUserRole: { userId: string, role: string, previousRole: string } };

export type DeactivateUserMutationVariables = Exact<{
  userId: string | number;
}>;


export type DeactivateUserMutation = { deactivateUser: { userId: string, status: string } };

export type ReactivateUserMutationVariables = Exact<{
  userId: string | number;
}>;


export type ReactivateUserMutation = { reactivateUser: { userId: string, status: string } };

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
  systemPrompt
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routeMatrix {
    route
    description
    openaiModel
    openaiEffort
    anthropicModel
    anthropicEffort
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
  systemPrompt
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routeMatrix {
    route
    description
    openaiModel
    openaiEffort
    anthropicModel
    anthropicEffort
  }
}`, {"fragmentName":"RoutingConfigDetailFields"}) as unknown as TypedDocumentString<RoutingConfigDetailFieldsFragment, unknown>;
export const ViewerFieldsFragmentDoc = new TypedDocumentString(`
    fragment ViewerFields on Viewer {
  user {
    sessionId
    organizationId
    userId
    email
    name
    role
  }
  organizationId
  organizations {
    id
    slug
    name
    role
  }
}
    `, {"fragmentName":"ViewerFields"}) as unknown as TypedDocumentString<ViewerFieldsFragment, unknown>;
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
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
    baseline
    savings
  }
}
    `, {"fragmentName":"UsageGroupFields"}) as unknown as TypedDocumentString<UsageGroupFieldsFragment, unknown>;
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
  settings {
    budgets {
      warningEstimatedInputTokens
      maxEstimatedInputTokens
      maxRoute
    }
  }
}
    `) as unknown as TypedDocumentString<BillingPageQuery, BillingPageQueryVariables>;
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
export const OverviewPageDocument = new TypedDocumentString(`
    query OverviewPage {
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
  modelUsage: usage(groupBy: model) {
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
export const ProviderAccountsDocument = new TypedDocumentString(`
    query ProviderAccounts {
  providerAccounts {
    id
    organizationId
    provider
    name
    authType
    status
    secretHint
    ownerUserId
    boundKeyCount
    createdAt
    lastUsedAt
  }
}
    `) as unknown as TypedDocumentString<ProviderAccountsQuery, ProviderAccountsQueryVariables>;
export const CreateProviderCredentialDocument = new TypedDocumentString(`
    mutation CreateProviderCredential($input: CreateProviderCredentialInput!) {
  createProviderCredential(input: $input) {
    id
    name
  }
}
    `) as unknown as TypedDocumentString<CreateProviderCredentialMutation, CreateProviderCredentialMutationVariables>;
export const RevokeProviderCredentialDocument = new TypedDocumentString(`
    mutation RevokeProviderCredential($providerAccountId: ID!) {
  revokeProviderCredential(providerAccountId: $providerAccountId) {
    id
    status
  }
}
    `) as unknown as TypedDocumentString<RevokeProviderCredentialMutation, RevokeProviderCredentialMutationVariables>;
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
    query RequestsPage {
  prompts {
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
  requests {
    requestId
    selectedModel
    terminalStatus
    latencyMs
    finalRoute
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
  }
}
    fragment RoutingConfigSummaryFields on RoutingConfigSummary {
  id
  name
  slug
  description
  status
  systemPrompt
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routeMatrix {
    route
    description
    openaiModel
    openaiEffort
    anthropicModel
    anthropicEffort
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
  systemPrompt
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routeMatrix {
    route
    description
    openaiModel
    openaiEffort
    anthropicModel
    anthropicEffort
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
    scopes
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
  systemPrompt
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routeMatrix {
    route
    description
    openaiModel
    openaiEffort
    anthropicModel
    anthropicEffort
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
  systemPrompt
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routeMatrix {
    route
    description
    openaiModel
    openaiEffort
    anthropicModel
    anthropicEffort
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
  systemPrompt
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routeMatrix {
    route
    description
    openaiModel
    openaiEffort
    anthropicModel
    anthropicEffort
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
  systemPrompt
  activeVersionId
  assignedApiKeyCount
  updatedAt
  activeVersion {
    id
    version
    configHash
  }
  routeMatrix {
    route
    description
    openaiModel
    openaiEffort
    anthropicModel
    anthropicEffort
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
    userId
    email
    name
    role
  }
  organizationId
  organizations {
    id
    slug
    name
    role
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
    userId
    email
    name
    role
  }
  organizationId
  organizations {
    id
    slug
    name
    role
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
    userId
    email
    name
    role
  }
  organizationId
  organizations {
    id
    slug
    name
    role
  }
}`) as unknown as TypedDocumentString<SwitchOrganizationMutation, SwitchOrganizationMutationVariables>;
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
      recentActivity
      modelMix
      routeMix
      usage {
        totalTokens
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
      selectedCost
      usage {
        totalTokens
      }
    }
    promptArtifacts {
      artifactId
      requestId
      kind
      rawText
      redactedText
      preview
    }
  }
}
    `) as unknown as TypedDocumentString<SessionDetailViewQuery, SessionDetailViewQueryVariables>;
export const SettingsViewDocument = new TypedDocumentString(`
    query SettingsView {
  settings {
    organizationId
    databaseEnabled
    restartRequiredFor
    storage {
      path
      reason
    }
    settings {
      schemaVersion
      classifier {
        model
        timeoutMs
        maxAttempts
        allowRedactedExcerpt
      }
      budgets {
        warningEstimatedInputTokens
        maxEstimatedInputTokens
        maxRoute
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
}
    `) as unknown as TypedDocumentString<SettingsViewQuery, SettingsViewQueryVariables>;
export const UpdateSettingsDocument = new TypedDocumentString(`
    mutation UpdateSettings($input: SettingsInput!) {
  updateSettings(input: $input) {
    organizationId
    databaseEnabled
    restartRequiredFor
    storage {
      path
      reason
    }
    settings {
      schemaVersion
      classifier {
        model
        timeoutMs
        maxAttempts
        allowRedactedExcerpt
      }
      budgets {
        warningEstimatedInputTokens
        maxEstimatedInputTokens
        maxRoute
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
}
    `) as unknown as TypedDocumentString<UpdateSettingsMutation, UpdateSettingsMutationVariables>;
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
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
    baseline
    savings
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
    outputTokens
    reasoningTokens
    totalTokens
  }
  cost {
    selected
    baseline
    savings
  }
}`) as unknown as TypedDocumentString<UsageTimeseriesViewQuery, UsageTimeseriesViewQueryVariables>;
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
    requestCount
    sessionCount
    usage {
      totalTokens
    }
    cost {
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