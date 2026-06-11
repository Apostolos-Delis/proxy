/* eslint-disable */
import * as types from './graphql';



/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
    "\n  query BillingPage {\n    overview {\n      requestCount\n      cost {\n        selected\n        baseline\n        savings\n      }\n    }\n    settings {\n      budgets {\n        warningEstimatedInputTokens\n        maxEstimatedInputTokens\n        maxRoute\n      }\n    }\n  }\n": typeof types.BillingPageDocument,
    "\n  query InvitationsList {\n    invitations {\n      id\n      email\n      name\n      role\n      status\n      lastSentAt\n      expiresAt\n      invitedBy {\n        userId\n        name\n        email\n      }\n    }\n  }\n": typeof types.InvitationsListDocument,
    "\n  mutation ResendInvitation($invitationId: ID!) {\n    resendInvitation(invitationId: $invitationId) {\n      inviteUrl\n      emailDelivery {\n        transport\n        delivered\n        error\n      }\n    }\n  }\n": typeof types.ResendInvitationDocument,
    "\n  mutation RevokeInvitation($invitationId: ID!) {\n    revokeInvitation(invitationId: $invitationId) {\n      id\n      status\n    }\n  }\n": typeof types.RevokeInvitationDocument,
    "\n  query PublicInvitation($token: String!) {\n    publicInvitation(token: $token) {\n      organizationName\n      email\n      name\n      role\n      status\n      inviterName\n      expiresAt\n    }\n  }\n": typeof types.PublicInvitationDocument,
    "\n  mutation AcceptInvitation($token: String!, $name: String) {\n    acceptInvitation(token: $token, name: $name) {\n      ok\n      organizationId\n      userId\n      email\n      role\n    }\n  }\n": typeof types.AcceptInvitationDocument,
    "\n  mutation CreateInvitation($input: CreateInvitationInput!) {\n    createInvitation(input: $input) {\n      inviteUrl\n      emailDelivery {\n        transport\n        delivered\n        error\n      }\n    }\n  }\n": typeof types.CreateInvitationDocument,
    "\n  query ModelPricingCard {\n    modelPricing {\n      model\n      provider\n      source\n      seenInTraffic\n      inputCostPerMtok\n      outputCostPerMtok\n      cacheReadCostPerMtok\n      cacheWriteCostPerMtok\n      updatedAt\n    }\n  }\n": typeof types.ModelPricingCardDocument,
    "\n  mutation SetModelPricing($input: SetModelPricingInput!) {\n    setModelPricing(input: $input) {\n      model\n      provider\n      source\n      seenInTraffic\n      inputCostPerMtok\n      outputCostPerMtok\n      cacheReadCostPerMtok\n      cacheWriteCostPerMtok\n      updatedAt\n    }\n  }\n": typeof types.SetModelPricingDocument,
    "\n  mutation ClearModelPricing($provider: String!, $model: String!) {\n    clearModelPricing(provider: $provider, model: $model) {\n      model\n      provider\n      source\n      seenInTraffic\n      inputCostPerMtok\n      outputCostPerMtok\n      cacheReadCostPerMtok\n      cacheWriteCostPerMtok\n      updatedAt\n    }\n  }\n": typeof types.ClearModelPricingDocument,
    "\n  query OverviewPage {\n    overview {\n      requestCount\n      totals {\n        totalTokens\n      }\n      cost {\n        selected\n        baseline\n        savings\n      }\n      routeQuality {\n        lowConfidenceCount\n        cheaperLikelyWouldWorkCount\n        cheapCausedRetriesOrRepairsCount\n      }\n    }\n    requests {\n      createdAt\n      selectedCost\n      baselineCost\n      usage {\n        totalTokens\n      }\n    }\n    modelUsage: usage(groupBy: model) {\n      data {\n        key\n        usage {\n          totalTokens\n        }\n        cost {\n          selected\n        }\n      }\n    }\n  }\n": typeof types.OverviewPageDocument,
    "\n  query PromptDetailView($artifactId: ID!) {\n    prompt(artifactId: $artifactId) {\n      artifact {\n        artifactId\n        requestId\n        userId\n        sessionId\n        surface\n        kind\n        sourceIndex\n        storageMode\n        contentHash\n        chars\n        tokenEstimate\n        preview\n        rawText\n        redactedText\n        expiresAt\n        finalRoute\n        provider\n        selectedModel\n        classifier\n        createdAt\n        routingConfig {\n          configId\n          configName\n          versionId\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n      requestArtifacts {\n        artifactId\n        requestId\n        userId\n        sessionId\n        surface\n        kind\n        sourceIndex\n        storageMode\n        contentHash\n        chars\n        tokenEstimate\n        preview\n        rawText\n        redactedText\n        expiresAt\n        finalRoute\n        provider\n        selectedModel\n        classifier\n        createdAt\n        routingConfig {\n          configId\n          configName\n          versionId\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n      request {\n        requestId\n        terminalStatus\n        finalRoute\n        requestedModel\n        selectedModel\n        provider\n        latencyMs\n        timeToFirstByteMs\n        selectedCost\n        classifier\n        usage {\n          inputTokens\n          cachedInputTokens\n          outputTokens\n          reasoningTokens\n          totalTokens\n        }\n        routingConfig {\n          configId\n          configName\n          versionId\n          version\n          configHash\n        }\n      }\n      events {\n        eventId\n        eventType\n        producer\n        payload\n        createdAt\n      }\n    }\n  }\n": typeof types.PromptDetailViewDocument,
    "\n  query PromptsList {\n    prompts {\n      data {\n        artifactId\n        userId\n        sessionId\n        surface\n        kind\n        preview\n        finalRoute\n        selectedModel\n        createdAt\n        routingConfig {\n          configId\n          configName\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n    }\n  }\n": typeof types.PromptsListDocument,
    "\n  query ProviderAccounts {\n    providerAccounts {\n      id\n      organizationId\n      provider\n      name\n      authType\n      status\n      secretHint\n      ownerUserId\n      boundKeyCount\n      createdAt\n      lastUsedAt\n    }\n  }\n": typeof types.ProviderAccountsDocument,
    "\n  mutation CreateProviderCredential($input: CreateProviderCredentialInput!) {\n    createProviderCredential(input: $input) {\n      id\n      name\n    }\n  }\n": typeof types.CreateProviderCredentialDocument,
    "\n  mutation RevokeProviderCredential($providerAccountId: ID!) {\n    revokeProviderCredential(providerAccountId: $providerAccountId) {\n      id\n      status\n    }\n  }\n": typeof types.RevokeProviderCredentialDocument,
    "\n  mutation AssignApiKeyProviderAccount($apiKeyId: ID!, $provider: String!, $providerAccountId: ID) {\n    assignApiKeyProviderAccount(apiKeyId: $apiKeyId, provider: $provider, providerAccountId: $providerAccountId) {\n      id\n      providerCredentials {\n        provider\n        providerAccountId\n        name\n        status\n      }\n    }\n  }\n": typeof types.AssignApiKeyProviderAccountDocument,
    "\n  query RequestsPage($start: String, $end: String, $limit: Int) {\n    prompts(start: $start, end: $end, limit: $limit) {\n      data {\n        artifactId\n        requestId\n        sessionId\n        userId\n        surface\n        kind\n        preview\n        tokenEstimate\n        selectedModel\n        finalRoute\n        provider\n        routingConfig {\n          configId\n          configName\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n    }\n    requests(start: $start, end: $end, limit: $limit) {\n      requestId\n      selectedModel\n      terminalStatus\n      latencyMs\n      finalRoute\n      provider\n      apiKeyId\n      sessionId\n      selectedCost\n      usage {\n        totalTokens\n      }\n      routingConfig {\n        configId\n        configName\n        version\n        configHash\n      }\n    }\n    users {\n      userId\n      name\n      email\n    }\n  }\n": typeof types.RequestsPageDocument,
    "\n  fragment RoutingConfigSummaryFields on RoutingConfigSummary {\n    id\n    name\n    slug\n    description\n    status\n    activeVersionId\n    assignedApiKeyCount\n    updatedAt\n    activeVersion {\n      id\n      version\n      configHash\n    }\n    routeMatrix {\n      route\n      description\n      openaiModel\n      openaiEffort\n      anthropicModel\n      anthropicEffort\n    }\n  }\n": typeof types.RoutingConfigSummaryFieldsFragmentDoc,
    "\n  fragment RoutingConfigDetailFields on RoutingConfigDetail {\n    config {\n      ...RoutingConfigSummaryFields\n    }\n    versions {\n      id\n      version\n      configHash\n      status\n      active\n      createdAt\n      activatedAt\n      config\n    }\n  }\n": typeof types.RoutingConfigDetailFieldsFragmentDoc,
    "\n  query RoutingConfigsList {\n    routingConfigs {\n      ...RoutingConfigSummaryFields\n    }\n  }\n": typeof types.RoutingConfigsListDocument,
    "\n  query RoutingConfigDetailView($configId: ID!) {\n    routingConfig(configId: $configId) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": typeof types.RoutingConfigDetailViewDocument,
    "\n  query RoutingApiKeys {\n    apiKeys {\n      id\n      name\n      userId\n      scopes\n      routingConfigId\n      createdAt\n      expiresAt\n      revokedAt\n      lastUsedAt\n      routingConfig {\n        id\n        name\n        status\n      }\n      providerCredentials {\n        provider\n        providerAccountId\n        name\n        status\n      }\n    }\n  }\n": typeof types.RoutingApiKeysDocument,
    "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      apiKey {\n        id\n        name\n      }\n      secret\n    }\n  }\n": typeof types.CreateApiKeyDocument,
    "\n  mutation RevokeApiKey($apiKeyId: ID!) {\n    revokeApiKey(apiKeyId: $apiKeyId) {\n      id\n      revokedAt\n    }\n  }\n": typeof types.RevokeApiKeyDocument,
    "\n  query ApiKeyVerification($apiKeyId: ID!) {\n    apiKey(apiKeyId: $apiKeyId) {\n      id\n      lastUsedAt\n    }\n  }\n": typeof types.ApiKeyVerificationDocument,
    "\n  mutation CreateRoutingConfig($input: CreateRoutingConfigInput!) {\n    createRoutingConfig(input: $input) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": typeof types.CreateRoutingConfigDocument,
    "\n  mutation CreateRoutingConfigVersion($configId: ID!, $config: JSON!) {\n    createRoutingConfigVersion(configId: $configId, config: $config) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": typeof types.CreateRoutingConfigVersionDocument,
    "\n  mutation ActivateRoutingConfigVersion($configId: ID!, $versionId: ID!) {\n    activateRoutingConfigVersion(configId: $configId, versionId: $versionId) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": typeof types.ActivateRoutingConfigVersionDocument,
    "\n  mutation ArchiveRoutingConfig($configId: ID!) {\n    archiveRoutingConfig(configId: $configId) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": typeof types.ArchiveRoutingConfigDocument,
    "\n  mutation AssignRoutingConfigKey($apiKeyId: ID!, $routingConfigId: ID) {\n    assignApiKeyRoutingConfig(apiKeyId: $apiKeyId, routingConfigId: $routingConfigId) {\n      id\n      routingConfigId\n    }\n  }\n": typeof types.AssignRoutingConfigKeyDocument,
    "\n  query GlobalSearch($query: String!) {\n    search(query: $query) {\n      results {\n        kind\n        id\n        title\n        subtitle\n        status\n        snippet\n        occurredAt\n      }\n    }\n  }\n": typeof types.GlobalSearchDocument,
    "\n  fragment ViewerFields on Viewer {\n    user {\n      sessionId\n      organizationId\n      workspaceId\n      userId\n      email\n      name\n      role\n    }\n    organizationId\n    workspaceId\n    organizations {\n      id\n      slug\n      name\n      role\n    }\n    workspaces {\n      id\n      slug\n      name\n    }\n  }\n": typeof types.ViewerFieldsFragmentDoc,
    "\n  query Viewer {\n    viewer {\n      ...ViewerFields\n    }\n  }\n": typeof types.ViewerDocument,
    "\n  mutation Login($email: String!, $password: String!) {\n    login(email: $email, password: $password) {\n      ...ViewerFields\n    }\n  }\n": typeof types.LoginDocument,
    "\n  mutation Logout {\n    logout\n  }\n": typeof types.LogoutDocument,
    "\n  mutation SwitchOrganization($organizationId: ID!) {\n    switchOrganization(organizationId: $organizationId) {\n      ...ViewerFields\n    }\n  }\n": typeof types.SwitchOrganizationDocument,
    "\n  mutation SwitchWorkspace($workspaceId: ID!) {\n    switchWorkspace(workspaceId: $workspaceId) {\n      ...ViewerFields\n    }\n  }\n": typeof types.SwitchWorkspaceDocument,
    "\n  mutation CreateWorkspace($input: CreateWorkspaceInput!) {\n    createWorkspace(input: $input) {\n      id\n      slug\n      name\n    }\n  }\n": typeof types.CreateWorkspaceDocument,
    "\n  query SessionDetailView($sessionId: ID!) {\n    session(sessionId: $sessionId) {\n      session {\n        sessionId\n        externalSessionId\n        userId\n        surface\n        sessionIdentity\n        requestCount\n        startedAt\n        recentActivity\n        modelMix\n        routeMix\n        usage {\n          totalTokens\n        }\n        cost {\n          selected\n        }\n      }\n      user\n      requests {\n        requestId\n        createdAt\n        selectedModel\n        finalRoute\n        terminalStatus\n        latencyMs\n        selectedCost\n        usage {\n          totalTokens\n        }\n      }\n      promptArtifacts {\n        artifactId\n        requestId\n        kind\n        sourceIndex\n        contentHash\n        createdAt\n        rawText\n        redactedText\n        preview\n      }\n    }\n  }\n": typeof types.SessionDetailViewDocument,
    "\n  query SessionsPage {\n    sessions {\n      sessionId\n      externalSessionId\n      userId\n      surface\n      currentRoute\n      requestCount\n      startedAt\n      recentActivity\n      modelMix\n      routeMix\n      terminalStatusSummary\n      usage {\n        totalTokens\n      }\n      cost {\n        selected\n      }\n    }\n    users {\n      userId\n      name\n      email\n    }\n  }\n": typeof types.SessionsPageDocument,
    "\n  fragment SettingsViewFields on Settings {\n    organizationId\n    databaseEnabled\n    restartRequiredFor\n    storage {\n      path\n      reason\n    }\n    settings {\n      schemaVersion\n      systemPrompt\n      classifier {\n        model\n        timeoutMs\n        maxAttempts\n        allowRedactedExcerpt\n      }\n      budgets {\n        warningEstimatedInputTokens\n        maxEstimatedInputTokens\n        maxRoute\n      }\n      routeQuality {\n        lowConfidenceThreshold\n      }\n      promptCapture {\n        promptCaptureMode\n        retentionDays\n      }\n    }\n  }\n": typeof types.SettingsViewFieldsFragmentDoc,
    "\n  query SettingsView {\n    settings {\n      ...SettingsViewFields\n    }\n  }\n": typeof types.SettingsViewDocument,
    "\n  mutation UpdateSettings($input: SettingsInput!) {\n    updateSettings(input: $input) {\n      ...SettingsViewFields\n    }\n  }\n": typeof types.UpdateSettingsDocument,
    "\n  query TokenAttributionView($start: String, $end: String) {\n    tokenAttribution(start: $start, end: $end) {\n      requestCount\n      sampled\n      buckets {\n        key\n        chars\n        estimatedTokens\n      }\n      toolSchemas {\n        name\n        chars\n        estimatedTokens\n        blocks\n      }\n      toolResults {\n        name\n        chars\n        estimatedTokens\n        blocks\n      }\n    }\n  }\n": typeof types.TokenAttributionViewDocument,
    "\n  fragment UsageGroupFields on UsageGroup {\n    key\n    requestCount\n    failedRequests\n    retriedRequests\n    failureRate\n    retryRate\n    latency {\n      averageMs\n      p95Ms\n    }\n    usage {\n      inputTokens\n      cachedInputTokens\n      cacheCreationInputTokens\n      outputTokens\n      reasoningTokens\n      totalTokens\n    }\n    cost {\n      selected\n      baseline\n      savings\n      classifier\n    }\n  }\n": typeof types.UsageGroupFieldsFragmentDoc,
    "\n  query UsageReportView($groupBy: UsageGroupBy!, $start: String, $end: String) {\n    usage(groupBy: $groupBy, start: $start, end: $end) {\n      groupBy\n      data {\n        ...UsageGroupFields\n      }\n      totals {\n        ...UsageGroupFields\n      }\n    }\n  }\n": typeof types.UsageReportViewDocument,
    "\n  query UsageTimeseriesView($groupBy: UsageGroupBy!, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {\n    usageTimeseries(groupBy: $groupBy, interval: $interval, start: $start, end: $end, limit: $limit) {\n      groupBy\n      interval\n      start\n      end\n      groups {\n        ...UsageGroupFields\n      }\n      points {\n        ts\n        totals {\n          ...UsageGroupFields\n        }\n        groups\n      }\n    }\n  }\n": typeof types.UsageTimeseriesViewDocument,
    "\n  query UsageLookups {\n    members {\n      userId\n      name\n      email\n    }\n    apiKeys {\n      id\n      name\n      revokedAt\n    }\n  }\n": typeof types.UsageLookupsDocument,
    "\n  query UnpricedModels {\n    modelPricing {\n      model\n      provider\n      source\n      seenInTraffic\n    }\n  }\n": typeof types.UnpricedModelsDocument,
    "\n  mutation DeactivateUser($userId: ID!) {\n    deactivateUser(userId: $userId) {\n      userId\n      status\n    }\n  }\n": typeof types.DeactivateUserDocument,
    "\n  mutation ReactivateUser($userId: ID!) {\n    reactivateUser(userId: $userId) {\n      userId\n      status\n    }\n  }\n": typeof types.ReactivateUserDocument,
    "\n  query UsersList {\n    users {\n      userId\n      email\n      name\n      externalId\n      membership {\n        role\n        status\n      }\n      requestCount\n      sessionCount\n      usage {\n        totalTokens\n      }\n      cost {\n        selected\n      }\n      recentActivity\n      createdAt\n    }\n  }\n": typeof types.UsersListDocument,
    "\n  mutation UpdateUserRole($userId: ID!, $role: MemberRole!) {\n    updateUserRole(userId: $userId, role: $role) {\n      userId\n      role\n      previousRole\n    }\n  }\n": typeof types.UpdateUserRoleDocument,
};
const documents: Documents = {
    "\n  query BillingPage {\n    overview {\n      requestCount\n      cost {\n        selected\n        baseline\n        savings\n      }\n    }\n    settings {\n      budgets {\n        warningEstimatedInputTokens\n        maxEstimatedInputTokens\n        maxRoute\n      }\n    }\n  }\n": types.BillingPageDocument,
    "\n  query InvitationsList {\n    invitations {\n      id\n      email\n      name\n      role\n      status\n      lastSentAt\n      expiresAt\n      invitedBy {\n        userId\n        name\n        email\n      }\n    }\n  }\n": types.InvitationsListDocument,
    "\n  mutation ResendInvitation($invitationId: ID!) {\n    resendInvitation(invitationId: $invitationId) {\n      inviteUrl\n      emailDelivery {\n        transport\n        delivered\n        error\n      }\n    }\n  }\n": types.ResendInvitationDocument,
    "\n  mutation RevokeInvitation($invitationId: ID!) {\n    revokeInvitation(invitationId: $invitationId) {\n      id\n      status\n    }\n  }\n": types.RevokeInvitationDocument,
    "\n  query PublicInvitation($token: String!) {\n    publicInvitation(token: $token) {\n      organizationName\n      email\n      name\n      role\n      status\n      inviterName\n      expiresAt\n    }\n  }\n": types.PublicInvitationDocument,
    "\n  mutation AcceptInvitation($token: String!, $name: String) {\n    acceptInvitation(token: $token, name: $name) {\n      ok\n      organizationId\n      userId\n      email\n      role\n    }\n  }\n": types.AcceptInvitationDocument,
    "\n  mutation CreateInvitation($input: CreateInvitationInput!) {\n    createInvitation(input: $input) {\n      inviteUrl\n      emailDelivery {\n        transport\n        delivered\n        error\n      }\n    }\n  }\n": types.CreateInvitationDocument,
    "\n  query ModelPricingCard {\n    modelPricing {\n      model\n      provider\n      source\n      seenInTraffic\n      inputCostPerMtok\n      outputCostPerMtok\n      cacheReadCostPerMtok\n      cacheWriteCostPerMtok\n      updatedAt\n    }\n  }\n": types.ModelPricingCardDocument,
    "\n  mutation SetModelPricing($input: SetModelPricingInput!) {\n    setModelPricing(input: $input) {\n      model\n      provider\n      source\n      seenInTraffic\n      inputCostPerMtok\n      outputCostPerMtok\n      cacheReadCostPerMtok\n      cacheWriteCostPerMtok\n      updatedAt\n    }\n  }\n": types.SetModelPricingDocument,
    "\n  mutation ClearModelPricing($provider: String!, $model: String!) {\n    clearModelPricing(provider: $provider, model: $model) {\n      model\n      provider\n      source\n      seenInTraffic\n      inputCostPerMtok\n      outputCostPerMtok\n      cacheReadCostPerMtok\n      cacheWriteCostPerMtok\n      updatedAt\n    }\n  }\n": types.ClearModelPricingDocument,
    "\n  query OverviewPage {\n    overview {\n      requestCount\n      totals {\n        totalTokens\n      }\n      cost {\n        selected\n        baseline\n        savings\n      }\n      routeQuality {\n        lowConfidenceCount\n        cheaperLikelyWouldWorkCount\n        cheapCausedRetriesOrRepairsCount\n      }\n    }\n    requests {\n      createdAt\n      selectedCost\n      baselineCost\n      usage {\n        totalTokens\n      }\n    }\n    modelUsage: usage(groupBy: model) {\n      data {\n        key\n        usage {\n          totalTokens\n        }\n        cost {\n          selected\n        }\n      }\n    }\n  }\n": types.OverviewPageDocument,
    "\n  query PromptDetailView($artifactId: ID!) {\n    prompt(artifactId: $artifactId) {\n      artifact {\n        artifactId\n        requestId\n        userId\n        sessionId\n        surface\n        kind\n        sourceIndex\n        storageMode\n        contentHash\n        chars\n        tokenEstimate\n        preview\n        rawText\n        redactedText\n        expiresAt\n        finalRoute\n        provider\n        selectedModel\n        classifier\n        createdAt\n        routingConfig {\n          configId\n          configName\n          versionId\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n      requestArtifacts {\n        artifactId\n        requestId\n        userId\n        sessionId\n        surface\n        kind\n        sourceIndex\n        storageMode\n        contentHash\n        chars\n        tokenEstimate\n        preview\n        rawText\n        redactedText\n        expiresAt\n        finalRoute\n        provider\n        selectedModel\n        classifier\n        createdAt\n        routingConfig {\n          configId\n          configName\n          versionId\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n      request {\n        requestId\n        terminalStatus\n        finalRoute\n        requestedModel\n        selectedModel\n        provider\n        latencyMs\n        timeToFirstByteMs\n        selectedCost\n        classifier\n        usage {\n          inputTokens\n          cachedInputTokens\n          outputTokens\n          reasoningTokens\n          totalTokens\n        }\n        routingConfig {\n          configId\n          configName\n          versionId\n          version\n          configHash\n        }\n      }\n      events {\n        eventId\n        eventType\n        producer\n        payload\n        createdAt\n      }\n    }\n  }\n": types.PromptDetailViewDocument,
    "\n  query PromptsList {\n    prompts {\n      data {\n        artifactId\n        userId\n        sessionId\n        surface\n        kind\n        preview\n        finalRoute\n        selectedModel\n        createdAt\n        routingConfig {\n          configId\n          configName\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n    }\n  }\n": types.PromptsListDocument,
    "\n  query ProviderAccounts {\n    providerAccounts {\n      id\n      organizationId\n      provider\n      name\n      authType\n      status\n      secretHint\n      ownerUserId\n      boundKeyCount\n      createdAt\n      lastUsedAt\n    }\n  }\n": types.ProviderAccountsDocument,
    "\n  mutation CreateProviderCredential($input: CreateProviderCredentialInput!) {\n    createProviderCredential(input: $input) {\n      id\n      name\n    }\n  }\n": types.CreateProviderCredentialDocument,
    "\n  mutation RevokeProviderCredential($providerAccountId: ID!) {\n    revokeProviderCredential(providerAccountId: $providerAccountId) {\n      id\n      status\n    }\n  }\n": types.RevokeProviderCredentialDocument,
    "\n  mutation AssignApiKeyProviderAccount($apiKeyId: ID!, $provider: String!, $providerAccountId: ID) {\n    assignApiKeyProviderAccount(apiKeyId: $apiKeyId, provider: $provider, providerAccountId: $providerAccountId) {\n      id\n      providerCredentials {\n        provider\n        providerAccountId\n        name\n        status\n      }\n    }\n  }\n": types.AssignApiKeyProviderAccountDocument,
    "\n  query RequestsPage($start: String, $end: String, $limit: Int) {\n    prompts(start: $start, end: $end, limit: $limit) {\n      data {\n        artifactId\n        requestId\n        sessionId\n        userId\n        surface\n        kind\n        preview\n        tokenEstimate\n        selectedModel\n        finalRoute\n        provider\n        routingConfig {\n          configId\n          configName\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n    }\n    requests(start: $start, end: $end, limit: $limit) {\n      requestId\n      selectedModel\n      terminalStatus\n      latencyMs\n      finalRoute\n      provider\n      apiKeyId\n      sessionId\n      selectedCost\n      usage {\n        totalTokens\n      }\n      routingConfig {\n        configId\n        configName\n        version\n        configHash\n      }\n    }\n    users {\n      userId\n      name\n      email\n    }\n  }\n": types.RequestsPageDocument,
    "\n  fragment RoutingConfigSummaryFields on RoutingConfigSummary {\n    id\n    name\n    slug\n    description\n    status\n    activeVersionId\n    assignedApiKeyCount\n    updatedAt\n    activeVersion {\n      id\n      version\n      configHash\n    }\n    routeMatrix {\n      route\n      description\n      openaiModel\n      openaiEffort\n      anthropicModel\n      anthropicEffort\n    }\n  }\n": types.RoutingConfigSummaryFieldsFragmentDoc,
    "\n  fragment RoutingConfigDetailFields on RoutingConfigDetail {\n    config {\n      ...RoutingConfigSummaryFields\n    }\n    versions {\n      id\n      version\n      configHash\n      status\n      active\n      createdAt\n      activatedAt\n      config\n    }\n  }\n": types.RoutingConfigDetailFieldsFragmentDoc,
    "\n  query RoutingConfigsList {\n    routingConfigs {\n      ...RoutingConfigSummaryFields\n    }\n  }\n": types.RoutingConfigsListDocument,
    "\n  query RoutingConfigDetailView($configId: ID!) {\n    routingConfig(configId: $configId) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": types.RoutingConfigDetailViewDocument,
    "\n  query RoutingApiKeys {\n    apiKeys {\n      id\n      name\n      userId\n      scopes\n      routingConfigId\n      createdAt\n      expiresAt\n      revokedAt\n      lastUsedAt\n      routingConfig {\n        id\n        name\n        status\n      }\n      providerCredentials {\n        provider\n        providerAccountId\n        name\n        status\n      }\n    }\n  }\n": types.RoutingApiKeysDocument,
    "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      apiKey {\n        id\n        name\n      }\n      secret\n    }\n  }\n": types.CreateApiKeyDocument,
    "\n  mutation RevokeApiKey($apiKeyId: ID!) {\n    revokeApiKey(apiKeyId: $apiKeyId) {\n      id\n      revokedAt\n    }\n  }\n": types.RevokeApiKeyDocument,
    "\n  query ApiKeyVerification($apiKeyId: ID!) {\n    apiKey(apiKeyId: $apiKeyId) {\n      id\n      lastUsedAt\n    }\n  }\n": types.ApiKeyVerificationDocument,
    "\n  mutation CreateRoutingConfig($input: CreateRoutingConfigInput!) {\n    createRoutingConfig(input: $input) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": types.CreateRoutingConfigDocument,
    "\n  mutation CreateRoutingConfigVersion($configId: ID!, $config: JSON!) {\n    createRoutingConfigVersion(configId: $configId, config: $config) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": types.CreateRoutingConfigVersionDocument,
    "\n  mutation ActivateRoutingConfigVersion($configId: ID!, $versionId: ID!) {\n    activateRoutingConfigVersion(configId: $configId, versionId: $versionId) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": types.ActivateRoutingConfigVersionDocument,
    "\n  mutation ArchiveRoutingConfig($configId: ID!) {\n    archiveRoutingConfig(configId: $configId) {\n      ...RoutingConfigDetailFields\n    }\n  }\n": types.ArchiveRoutingConfigDocument,
    "\n  mutation AssignRoutingConfigKey($apiKeyId: ID!, $routingConfigId: ID) {\n    assignApiKeyRoutingConfig(apiKeyId: $apiKeyId, routingConfigId: $routingConfigId) {\n      id\n      routingConfigId\n    }\n  }\n": types.AssignRoutingConfigKeyDocument,
    "\n  query GlobalSearch($query: String!) {\n    search(query: $query) {\n      results {\n        kind\n        id\n        title\n        subtitle\n        status\n        snippet\n        occurredAt\n      }\n    }\n  }\n": types.GlobalSearchDocument,
    "\n  fragment ViewerFields on Viewer {\n    user {\n      sessionId\n      organizationId\n      workspaceId\n      userId\n      email\n      name\n      role\n    }\n    organizationId\n    workspaceId\n    organizations {\n      id\n      slug\n      name\n      role\n    }\n    workspaces {\n      id\n      slug\n      name\n    }\n  }\n": types.ViewerFieldsFragmentDoc,
    "\n  query Viewer {\n    viewer {\n      ...ViewerFields\n    }\n  }\n": types.ViewerDocument,
    "\n  mutation Login($email: String!, $password: String!) {\n    login(email: $email, password: $password) {\n      ...ViewerFields\n    }\n  }\n": types.LoginDocument,
    "\n  mutation Logout {\n    logout\n  }\n": types.LogoutDocument,
    "\n  mutation SwitchOrganization($organizationId: ID!) {\n    switchOrganization(organizationId: $organizationId) {\n      ...ViewerFields\n    }\n  }\n": types.SwitchOrganizationDocument,
    "\n  mutation SwitchWorkspace($workspaceId: ID!) {\n    switchWorkspace(workspaceId: $workspaceId) {\n      ...ViewerFields\n    }\n  }\n": types.SwitchWorkspaceDocument,
    "\n  mutation CreateWorkspace($input: CreateWorkspaceInput!) {\n    createWorkspace(input: $input) {\n      id\n      slug\n      name\n    }\n  }\n": types.CreateWorkspaceDocument,
    "\n  query SessionDetailView($sessionId: ID!) {\n    session(sessionId: $sessionId) {\n      session {\n        sessionId\n        externalSessionId\n        userId\n        surface\n        sessionIdentity\n        requestCount\n        startedAt\n        recentActivity\n        modelMix\n        routeMix\n        usage {\n          totalTokens\n        }\n        cost {\n          selected\n        }\n      }\n      user\n      requests {\n        requestId\n        createdAt\n        selectedModel\n        finalRoute\n        terminalStatus\n        latencyMs\n        selectedCost\n        usage {\n          totalTokens\n        }\n      }\n      promptArtifacts {\n        artifactId\n        requestId\n        kind\n        sourceIndex\n        contentHash\n        createdAt\n        rawText\n        redactedText\n        preview\n      }\n    }\n  }\n": types.SessionDetailViewDocument,
    "\n  query SessionsPage {\n    sessions {\n      sessionId\n      externalSessionId\n      userId\n      surface\n      currentRoute\n      requestCount\n      startedAt\n      recentActivity\n      modelMix\n      routeMix\n      terminalStatusSummary\n      usage {\n        totalTokens\n      }\n      cost {\n        selected\n      }\n    }\n    users {\n      userId\n      name\n      email\n    }\n  }\n": types.SessionsPageDocument,
    "\n  fragment SettingsViewFields on Settings {\n    organizationId\n    databaseEnabled\n    restartRequiredFor\n    storage {\n      path\n      reason\n    }\n    settings {\n      schemaVersion\n      systemPrompt\n      classifier {\n        model\n        timeoutMs\n        maxAttempts\n        allowRedactedExcerpt\n      }\n      budgets {\n        warningEstimatedInputTokens\n        maxEstimatedInputTokens\n        maxRoute\n      }\n      routeQuality {\n        lowConfidenceThreshold\n      }\n      promptCapture {\n        promptCaptureMode\n        retentionDays\n      }\n    }\n  }\n": types.SettingsViewFieldsFragmentDoc,
    "\n  query SettingsView {\n    settings {\n      ...SettingsViewFields\n    }\n  }\n": types.SettingsViewDocument,
    "\n  mutation UpdateSettings($input: SettingsInput!) {\n    updateSettings(input: $input) {\n      ...SettingsViewFields\n    }\n  }\n": types.UpdateSettingsDocument,
    "\n  query TokenAttributionView($start: String, $end: String) {\n    tokenAttribution(start: $start, end: $end) {\n      requestCount\n      sampled\n      buckets {\n        key\n        chars\n        estimatedTokens\n      }\n      toolSchemas {\n        name\n        chars\n        estimatedTokens\n        blocks\n      }\n      toolResults {\n        name\n        chars\n        estimatedTokens\n        blocks\n      }\n    }\n  }\n": types.TokenAttributionViewDocument,
    "\n  fragment UsageGroupFields on UsageGroup {\n    key\n    requestCount\n    failedRequests\n    retriedRequests\n    failureRate\n    retryRate\n    latency {\n      averageMs\n      p95Ms\n    }\n    usage {\n      inputTokens\n      cachedInputTokens\n      cacheCreationInputTokens\n      outputTokens\n      reasoningTokens\n      totalTokens\n    }\n    cost {\n      selected\n      baseline\n      savings\n      classifier\n    }\n  }\n": types.UsageGroupFieldsFragmentDoc,
    "\n  query UsageReportView($groupBy: UsageGroupBy!, $start: String, $end: String) {\n    usage(groupBy: $groupBy, start: $start, end: $end) {\n      groupBy\n      data {\n        ...UsageGroupFields\n      }\n      totals {\n        ...UsageGroupFields\n      }\n    }\n  }\n": types.UsageReportViewDocument,
    "\n  query UsageTimeseriesView($groupBy: UsageGroupBy!, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {\n    usageTimeseries(groupBy: $groupBy, interval: $interval, start: $start, end: $end, limit: $limit) {\n      groupBy\n      interval\n      start\n      end\n      groups {\n        ...UsageGroupFields\n      }\n      points {\n        ts\n        totals {\n          ...UsageGroupFields\n        }\n        groups\n      }\n    }\n  }\n": types.UsageTimeseriesViewDocument,
    "\n  query UsageLookups {\n    members {\n      userId\n      name\n      email\n    }\n    apiKeys {\n      id\n      name\n      revokedAt\n    }\n  }\n": types.UsageLookupsDocument,
    "\n  query UnpricedModels {\n    modelPricing {\n      model\n      provider\n      source\n      seenInTraffic\n    }\n  }\n": types.UnpricedModelsDocument,
    "\n  mutation DeactivateUser($userId: ID!) {\n    deactivateUser(userId: $userId) {\n      userId\n      status\n    }\n  }\n": types.DeactivateUserDocument,
    "\n  mutation ReactivateUser($userId: ID!) {\n    reactivateUser(userId: $userId) {\n      userId\n      status\n    }\n  }\n": types.ReactivateUserDocument,
    "\n  query UsersList {\n    users {\n      userId\n      email\n      name\n      externalId\n      membership {\n        role\n        status\n      }\n      requestCount\n      sessionCount\n      usage {\n        totalTokens\n      }\n      cost {\n        selected\n      }\n      recentActivity\n      createdAt\n    }\n  }\n": types.UsersListDocument,
    "\n  mutation UpdateUserRole($userId: ID!, $role: MemberRole!) {\n    updateUserRole(userId: $userId, role: $role) {\n      userId\n      role\n      previousRole\n    }\n  }\n": types.UpdateUserRoleDocument,
};

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query BillingPage {\n    overview {\n      requestCount\n      cost {\n        selected\n        baseline\n        savings\n      }\n    }\n    settings {\n      budgets {\n        warningEstimatedInputTokens\n        maxEstimatedInputTokens\n        maxRoute\n      }\n    }\n  }\n"): typeof import('./graphql').BillingPageDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query InvitationsList {\n    invitations {\n      id\n      email\n      name\n      role\n      status\n      lastSentAt\n      expiresAt\n      invitedBy {\n        userId\n        name\n        email\n      }\n    }\n  }\n"): typeof import('./graphql').InvitationsListDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation ResendInvitation($invitationId: ID!) {\n    resendInvitation(invitationId: $invitationId) {\n      inviteUrl\n      emailDelivery {\n        transport\n        delivered\n        error\n      }\n    }\n  }\n"): typeof import('./graphql').ResendInvitationDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RevokeInvitation($invitationId: ID!) {\n    revokeInvitation(invitationId: $invitationId) {\n      id\n      status\n    }\n  }\n"): typeof import('./graphql').RevokeInvitationDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query PublicInvitation($token: String!) {\n    publicInvitation(token: $token) {\n      organizationName\n      email\n      name\n      role\n      status\n      inviterName\n      expiresAt\n    }\n  }\n"): typeof import('./graphql').PublicInvitationDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation AcceptInvitation($token: String!, $name: String) {\n    acceptInvitation(token: $token, name: $name) {\n      ok\n      organizationId\n      userId\n      email\n      role\n    }\n  }\n"): typeof import('./graphql').AcceptInvitationDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateInvitation($input: CreateInvitationInput!) {\n    createInvitation(input: $input) {\n      inviteUrl\n      emailDelivery {\n        transport\n        delivered\n        error\n      }\n    }\n  }\n"): typeof import('./graphql').CreateInvitationDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ModelPricingCard {\n    modelPricing {\n      model\n      provider\n      source\n      seenInTraffic\n      inputCostPerMtok\n      outputCostPerMtok\n      cacheReadCostPerMtok\n      cacheWriteCostPerMtok\n      updatedAt\n    }\n  }\n"): typeof import('./graphql').ModelPricingCardDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SetModelPricing($input: SetModelPricingInput!) {\n    setModelPricing(input: $input) {\n      model\n      provider\n      source\n      seenInTraffic\n      inputCostPerMtok\n      outputCostPerMtok\n      cacheReadCostPerMtok\n      cacheWriteCostPerMtok\n      updatedAt\n    }\n  }\n"): typeof import('./graphql').SetModelPricingDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation ClearModelPricing($provider: String!, $model: String!) {\n    clearModelPricing(provider: $provider, model: $model) {\n      model\n      provider\n      source\n      seenInTraffic\n      inputCostPerMtok\n      outputCostPerMtok\n      cacheReadCostPerMtok\n      cacheWriteCostPerMtok\n      updatedAt\n    }\n  }\n"): typeof import('./graphql').ClearModelPricingDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query OverviewPage {\n    overview {\n      requestCount\n      totals {\n        totalTokens\n      }\n      cost {\n        selected\n        baseline\n        savings\n      }\n      routeQuality {\n        lowConfidenceCount\n        cheaperLikelyWouldWorkCount\n        cheapCausedRetriesOrRepairsCount\n      }\n    }\n    requests {\n      createdAt\n      selectedCost\n      baselineCost\n      usage {\n        totalTokens\n      }\n    }\n    modelUsage: usage(groupBy: model) {\n      data {\n        key\n        usage {\n          totalTokens\n        }\n        cost {\n          selected\n        }\n      }\n    }\n  }\n"): typeof import('./graphql').OverviewPageDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query PromptDetailView($artifactId: ID!) {\n    prompt(artifactId: $artifactId) {\n      artifact {\n        artifactId\n        requestId\n        userId\n        sessionId\n        surface\n        kind\n        sourceIndex\n        storageMode\n        contentHash\n        chars\n        tokenEstimate\n        preview\n        rawText\n        redactedText\n        expiresAt\n        finalRoute\n        provider\n        selectedModel\n        classifier\n        createdAt\n        routingConfig {\n          configId\n          configName\n          versionId\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n      requestArtifacts {\n        artifactId\n        requestId\n        userId\n        sessionId\n        surface\n        kind\n        sourceIndex\n        storageMode\n        contentHash\n        chars\n        tokenEstimate\n        preview\n        rawText\n        redactedText\n        expiresAt\n        finalRoute\n        provider\n        selectedModel\n        classifier\n        createdAt\n        routingConfig {\n          configId\n          configName\n          versionId\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n      request {\n        requestId\n        terminalStatus\n        finalRoute\n        requestedModel\n        selectedModel\n        provider\n        latencyMs\n        timeToFirstByteMs\n        selectedCost\n        classifier\n        usage {\n          inputTokens\n          cachedInputTokens\n          outputTokens\n          reasoningTokens\n          totalTokens\n        }\n        routingConfig {\n          configId\n          configName\n          versionId\n          version\n          configHash\n        }\n      }\n      events {\n        eventId\n        eventType\n        producer\n        payload\n        createdAt\n      }\n    }\n  }\n"): typeof import('./graphql').PromptDetailViewDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query PromptsList {\n    prompts {\n      data {\n        artifactId\n        userId\n        sessionId\n        surface\n        kind\n        preview\n        finalRoute\n        selectedModel\n        createdAt\n        routingConfig {\n          configId\n          configName\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n    }\n  }\n"): typeof import('./graphql').PromptsListDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ProviderAccounts {\n    providerAccounts {\n      id\n      organizationId\n      provider\n      name\n      authType\n      status\n      secretHint\n      ownerUserId\n      boundKeyCount\n      createdAt\n      lastUsedAt\n    }\n  }\n"): typeof import('./graphql').ProviderAccountsDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateProviderCredential($input: CreateProviderCredentialInput!) {\n    createProviderCredential(input: $input) {\n      id\n      name\n    }\n  }\n"): typeof import('./graphql').CreateProviderCredentialDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RevokeProviderCredential($providerAccountId: ID!) {\n    revokeProviderCredential(providerAccountId: $providerAccountId) {\n      id\n      status\n    }\n  }\n"): typeof import('./graphql').RevokeProviderCredentialDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation AssignApiKeyProviderAccount($apiKeyId: ID!, $provider: String!, $providerAccountId: ID) {\n    assignApiKeyProviderAccount(apiKeyId: $apiKeyId, provider: $provider, providerAccountId: $providerAccountId) {\n      id\n      providerCredentials {\n        provider\n        providerAccountId\n        name\n        status\n      }\n    }\n  }\n"): typeof import('./graphql').AssignApiKeyProviderAccountDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query RequestsPage($start: String, $end: String, $limit: Int) {\n    prompts(start: $start, end: $end, limit: $limit) {\n      data {\n        artifactId\n        requestId\n        sessionId\n        userId\n        surface\n        kind\n        preview\n        tokenEstimate\n        selectedModel\n        finalRoute\n        provider\n        routingConfig {\n          configId\n          configName\n          version\n          configHash\n        }\n        cost {\n          selected\n        }\n      }\n    }\n    requests(start: $start, end: $end, limit: $limit) {\n      requestId\n      selectedModel\n      terminalStatus\n      latencyMs\n      finalRoute\n      provider\n      apiKeyId\n      sessionId\n      selectedCost\n      usage {\n        totalTokens\n      }\n      routingConfig {\n        configId\n        configName\n        version\n        configHash\n      }\n    }\n    users {\n      userId\n      name\n      email\n    }\n  }\n"): typeof import('./graphql').RequestsPageDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment RoutingConfigSummaryFields on RoutingConfigSummary {\n    id\n    name\n    slug\n    description\n    status\n    activeVersionId\n    assignedApiKeyCount\n    updatedAt\n    activeVersion {\n      id\n      version\n      configHash\n    }\n    routeMatrix {\n      route\n      description\n      openaiModel\n      openaiEffort\n      anthropicModel\n      anthropicEffort\n    }\n  }\n"): typeof import('./graphql').RoutingConfigSummaryFieldsFragmentDoc;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment RoutingConfigDetailFields on RoutingConfigDetail {\n    config {\n      ...RoutingConfigSummaryFields\n    }\n    versions {\n      id\n      version\n      configHash\n      status\n      active\n      createdAt\n      activatedAt\n      config\n    }\n  }\n"): typeof import('./graphql').RoutingConfigDetailFieldsFragmentDoc;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query RoutingConfigsList {\n    routingConfigs {\n      ...RoutingConfigSummaryFields\n    }\n  }\n"): typeof import('./graphql').RoutingConfigsListDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query RoutingConfigDetailView($configId: ID!) {\n    routingConfig(configId: $configId) {\n      ...RoutingConfigDetailFields\n    }\n  }\n"): typeof import('./graphql').RoutingConfigDetailViewDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query RoutingApiKeys {\n    apiKeys {\n      id\n      name\n      userId\n      scopes\n      routingConfigId\n      createdAt\n      expiresAt\n      revokedAt\n      lastUsedAt\n      routingConfig {\n        id\n        name\n        status\n      }\n      providerCredentials {\n        provider\n        providerAccountId\n        name\n        status\n      }\n    }\n  }\n"): typeof import('./graphql').RoutingApiKeysDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateApiKey($input: CreateApiKeyInput!) {\n    createApiKey(input: $input) {\n      apiKey {\n        id\n        name\n      }\n      secret\n    }\n  }\n"): typeof import('./graphql').CreateApiKeyDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation RevokeApiKey($apiKeyId: ID!) {\n    revokeApiKey(apiKeyId: $apiKeyId) {\n      id\n      revokedAt\n    }\n  }\n"): typeof import('./graphql').RevokeApiKeyDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query ApiKeyVerification($apiKeyId: ID!) {\n    apiKey(apiKeyId: $apiKeyId) {\n      id\n      lastUsedAt\n    }\n  }\n"): typeof import('./graphql').ApiKeyVerificationDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateRoutingConfig($input: CreateRoutingConfigInput!) {\n    createRoutingConfig(input: $input) {\n      ...RoutingConfigDetailFields\n    }\n  }\n"): typeof import('./graphql').CreateRoutingConfigDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateRoutingConfigVersion($configId: ID!, $config: JSON!) {\n    createRoutingConfigVersion(configId: $configId, config: $config) {\n      ...RoutingConfigDetailFields\n    }\n  }\n"): typeof import('./graphql').CreateRoutingConfigVersionDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation ActivateRoutingConfigVersion($configId: ID!, $versionId: ID!) {\n    activateRoutingConfigVersion(configId: $configId, versionId: $versionId) {\n      ...RoutingConfigDetailFields\n    }\n  }\n"): typeof import('./graphql').ActivateRoutingConfigVersionDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation ArchiveRoutingConfig($configId: ID!) {\n    archiveRoutingConfig(configId: $configId) {\n      ...RoutingConfigDetailFields\n    }\n  }\n"): typeof import('./graphql').ArchiveRoutingConfigDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation AssignRoutingConfigKey($apiKeyId: ID!, $routingConfigId: ID) {\n    assignApiKeyRoutingConfig(apiKeyId: $apiKeyId, routingConfigId: $routingConfigId) {\n      id\n      routingConfigId\n    }\n  }\n"): typeof import('./graphql').AssignRoutingConfigKeyDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query GlobalSearch($query: String!) {\n    search(query: $query) {\n      results {\n        kind\n        id\n        title\n        subtitle\n        status\n        snippet\n        occurredAt\n      }\n    }\n  }\n"): typeof import('./graphql').GlobalSearchDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment ViewerFields on Viewer {\n    user {\n      sessionId\n      organizationId\n      workspaceId\n      userId\n      email\n      name\n      role\n    }\n    organizationId\n    workspaceId\n    organizations {\n      id\n      slug\n      name\n      role\n    }\n    workspaces {\n      id\n      slug\n      name\n    }\n  }\n"): typeof import('./graphql').ViewerFieldsFragmentDoc;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Viewer {\n    viewer {\n      ...ViewerFields\n    }\n  }\n"): typeof import('./graphql').ViewerDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation Login($email: String!, $password: String!) {\n    login(email: $email, password: $password) {\n      ...ViewerFields\n    }\n  }\n"): typeof import('./graphql').LoginDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation Logout {\n    logout\n  }\n"): typeof import('./graphql').LogoutDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SwitchOrganization($organizationId: ID!) {\n    switchOrganization(organizationId: $organizationId) {\n      ...ViewerFields\n    }\n  }\n"): typeof import('./graphql').SwitchOrganizationDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation SwitchWorkspace($workspaceId: ID!) {\n    switchWorkspace(workspaceId: $workspaceId) {\n      ...ViewerFields\n    }\n  }\n"): typeof import('./graphql').SwitchWorkspaceDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CreateWorkspace($input: CreateWorkspaceInput!) {\n    createWorkspace(input: $input) {\n      id\n      slug\n      name\n    }\n  }\n"): typeof import('./graphql').CreateWorkspaceDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query SessionDetailView($sessionId: ID!) {\n    session(sessionId: $sessionId) {\n      session {\n        sessionId\n        externalSessionId\n        userId\n        surface\n        sessionIdentity\n        requestCount\n        startedAt\n        recentActivity\n        modelMix\n        routeMix\n        usage {\n          totalTokens\n        }\n        cost {\n          selected\n        }\n      }\n      user\n      requests {\n        requestId\n        createdAt\n        selectedModel\n        finalRoute\n        terminalStatus\n        latencyMs\n        selectedCost\n        usage {\n          totalTokens\n        }\n      }\n      promptArtifacts {\n        artifactId\n        requestId\n        kind\n        sourceIndex\n        contentHash\n        createdAt\n        rawText\n        redactedText\n        preview\n      }\n    }\n  }\n"): typeof import('./graphql').SessionDetailViewDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query SessionsPage {\n    sessions {\n      sessionId\n      externalSessionId\n      userId\n      surface\n      currentRoute\n      requestCount\n      startedAt\n      recentActivity\n      modelMix\n      routeMix\n      terminalStatusSummary\n      usage {\n        totalTokens\n      }\n      cost {\n        selected\n      }\n    }\n    users {\n      userId\n      name\n      email\n    }\n  }\n"): typeof import('./graphql').SessionsPageDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment SettingsViewFields on Settings {\n    organizationId\n    databaseEnabled\n    restartRequiredFor\n    storage {\n      path\n      reason\n    }\n    settings {\n      schemaVersion\n      systemPrompt\n      classifier {\n        model\n        timeoutMs\n        maxAttempts\n        allowRedactedExcerpt\n      }\n      budgets {\n        warningEstimatedInputTokens\n        maxEstimatedInputTokens\n        maxRoute\n      }\n      routeQuality {\n        lowConfidenceThreshold\n      }\n      promptCapture {\n        promptCaptureMode\n        retentionDays\n      }\n    }\n  }\n"): typeof import('./graphql').SettingsViewFieldsFragmentDoc;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query SettingsView {\n    settings {\n      ...SettingsViewFields\n    }\n  }\n"): typeof import('./graphql').SettingsViewDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation UpdateSettings($input: SettingsInput!) {\n    updateSettings(input: $input) {\n      ...SettingsViewFields\n    }\n  }\n"): typeof import('./graphql').UpdateSettingsDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query TokenAttributionView($start: String, $end: String) {\n    tokenAttribution(start: $start, end: $end) {\n      requestCount\n      sampled\n      buckets {\n        key\n        chars\n        estimatedTokens\n      }\n      toolSchemas {\n        name\n        chars\n        estimatedTokens\n        blocks\n      }\n      toolResults {\n        name\n        chars\n        estimatedTokens\n        blocks\n      }\n    }\n  }\n"): typeof import('./graphql').TokenAttributionViewDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment UsageGroupFields on UsageGroup {\n    key\n    requestCount\n    failedRequests\n    retriedRequests\n    failureRate\n    retryRate\n    latency {\n      averageMs\n      p95Ms\n    }\n    usage {\n      inputTokens\n      cachedInputTokens\n      cacheCreationInputTokens\n      outputTokens\n      reasoningTokens\n      totalTokens\n    }\n    cost {\n      selected\n      baseline\n      savings\n      classifier\n    }\n  }\n"): typeof import('./graphql').UsageGroupFieldsFragmentDoc;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query UsageReportView($groupBy: UsageGroupBy!, $start: String, $end: String) {\n    usage(groupBy: $groupBy, start: $start, end: $end) {\n      groupBy\n      data {\n        ...UsageGroupFields\n      }\n      totals {\n        ...UsageGroupFields\n      }\n    }\n  }\n"): typeof import('./graphql').UsageReportViewDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query UsageTimeseriesView($groupBy: UsageGroupBy!, $interval: UsageInterval, $start: String, $end: String, $limit: Int) {\n    usageTimeseries(groupBy: $groupBy, interval: $interval, start: $start, end: $end, limit: $limit) {\n      groupBy\n      interval\n      start\n      end\n      groups {\n        ...UsageGroupFields\n      }\n      points {\n        ts\n        totals {\n          ...UsageGroupFields\n        }\n        groups\n      }\n    }\n  }\n"): typeof import('./graphql').UsageTimeseriesViewDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query UsageLookups {\n    members {\n      userId\n      name\n      email\n    }\n    apiKeys {\n      id\n      name\n      revokedAt\n    }\n  }\n"): typeof import('./graphql').UsageLookupsDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query UnpricedModels {\n    modelPricing {\n      model\n      provider\n      source\n      seenInTraffic\n    }\n  }\n"): typeof import('./graphql').UnpricedModelsDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation DeactivateUser($userId: ID!) {\n    deactivateUser(userId: $userId) {\n      userId\n      status\n    }\n  }\n"): typeof import('./graphql').DeactivateUserDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation ReactivateUser($userId: ID!) {\n    reactivateUser(userId: $userId) {\n      userId\n      status\n    }\n  }\n"): typeof import('./graphql').ReactivateUserDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query UsersList {\n    users {\n      userId\n      email\n      name\n      externalId\n      membership {\n        role\n        status\n      }\n      requestCount\n      sessionCount\n      usage {\n        totalTokens\n      }\n      cost {\n        selected\n      }\n      recentActivity\n      createdAt\n    }\n  }\n"): typeof import('./graphql').UsersListDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation UpdateUserRole($userId: ID!, $role: MemberRole!) {\n    updateUserRole(userId: $userId, role: $role) {\n      userId\n      role\n      previousRole\n    }\n  }\n"): typeof import('./graphql').UpdateUserRoleDocument;


export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}
