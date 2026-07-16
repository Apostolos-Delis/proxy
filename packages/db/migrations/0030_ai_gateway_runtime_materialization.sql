ALTER TABLE provider_connections
  ADD COLUMN IF NOT EXISTS platform_owned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS forward_harness_headers boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS legacy_provider_account_id text;

CREATE TEMP TABLE gateway_legacy_configs ON COMMIT DROP AS
WITH used_configs AS (
  SELECT
    k.organization_id,
    k.workspace_id,
    COALESCE(k.routing_config_id, w.default_routing_config_id) AS routing_config_id
  FROM api_keys k
  JOIN workspaces w
    ON w.organization_id = k.organization_id
   AND w.id = k.workspace_id
  WHERE k.revoked_at IS NULL
    AND (k.expires_at IS NULL OR k.expires_at > now())
    AND k.access_profile_id IS NULL
  UNION
  SELECT organization_id, id, default_routing_config_id
  FROM workspaces
  WHERE default_routing_config_id IS NOT NULL
)
SELECT
  u.organization_id,
  u.workspace_id,
  u.routing_config_id,
  r.name AS routing_config_name,
  v.config
FROM used_configs u
JOIN routing_configs r
  ON r.organization_id = u.organization_id
 AND r.workspace_id = u.workspace_id
 AND r.id = u.routing_config_id
 AND r.status = 'active'
JOIN routing_config_versions v
  ON v.organization_id = r.organization_id
 AND v.workspace_id = r.workspace_id
 AND v.routing_config_id = r.id
 AND v.id = r.active_version_id
 AND v.status = 'active';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_configs
    GROUP BY organization_id, workspace_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover cannot map multiple active routing configs in one workspace';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_configs
    WHERE jsonb_typeof(config -> 'routes') <> 'object'
       OR jsonb_typeof(config -> 'classifier') <> 'object'
       OR NULLIF(config #>> '{classifier,providerId}', '') IS NULL
       OR NULLIF(config #>> '{classifier,model}', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found an invalid active routing config';
  END IF;
END;
$$;

CREATE TEMP TABLE gateway_legacy_deployment_candidates ON COMMIT DROP AS
SELECT
  c.organization_id,
  c.workspace_id,
  c.routing_config_id,
  COALESCE(NULLIF(deployment ->> 'provider', ''), provider_block.key) AS provider,
  deployment ->> 'model' AS model,
  NULLIF(deployment ->> 'providerAccountId', '') AS requested_provider_account_id,
  deployment,
  false AS classifier,
  CASE route.key
    WHEN 'fast' THEN 0
    WHEN 'balanced' THEN 1000
    WHEN 'hard' THEN 2000
    WHEN 'deep' THEN 3000
    ELSE 4000
  END + COALESCE((deployment ->> 'order')::integer, 0) AS priority
FROM gateway_legacy_configs c
CROSS JOIN LATERAL jsonb_each(c.config -> 'routes') AS route
CROSS JOIN LATERAL jsonb_each(route.value) AS provider_block
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(provider_block.value -> 'deployments') = 'array'
      THEN provider_block.value -> 'deployments'
    ELSE '[]'::jsonb
  END
) AS deployment
WHERE provider_block.key NOT IN ('description', 'retry')
UNION ALL
SELECT
  c.organization_id,
  c.workspace_id,
  c.routing_config_id,
  c.config #>> '{classifier,providerId}',
  c.config #>> '{classifier,model}',
  NULL,
  jsonb_build_object(
    'provider', c.config #>> '{classifier,providerId}',
    'model', c.config #>> '{classifier,model}',
    'timeoutMs', COALESCE((c.config #>> '{classifier,timeoutMs}')::integer, 10000)
  ),
  true,
  -1
FROM gateway_legacy_configs c;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployment_candidates
    WHERE NULLIF(provider, '') IS NULL OR NULLIF(model, '') IS NULL
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found an active deployment without provider and model';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployment_candidates
    GROUP BY organization_id, workspace_id, provider, model
    HAVING count(DISTINCT jsonb_build_object(
      'providerAccountId', requested_provider_account_id,
      'deployment', deployment - ARRAY['order', 'weight']::text[]
    )) > 1
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found conflicting settings for one provider model';
  END IF;
END;
$$;

CREATE TEMP TABLE gateway_legacy_credential_choices ON COMMIT DROP AS
SELECT DISTINCT
  d.organization_id,
  d.workspace_id,
  d.routing_config_id,
  d.provider,
  CASE
    WHEN d.classifier THEN 'platform'
    WHEN d.requested_provider_account_id IS NOT NULL THEN 'account'
    WHEN k.id IS NOT NULL AND b.provider_account_id IS NOT NULL THEN 'account'
    ELSE 'platform'
  END AS credential_kind,
  CASE
    WHEN d.classifier THEN NULL
    WHEN d.requested_provider_account_id IS NOT NULL THEN d.requested_provider_account_id
    ELSE b.provider_account_id
  END AS requested_provider_account_id
FROM gateway_legacy_deployment_candidates d
LEFT JOIN LATERAL (
  SELECT provider.id
  FROM providers provider
  WHERE provider.slug = d.provider
    AND (provider.organization_id = d.organization_id OR provider.organization_id IS NULL)
    AND provider.enabled = true
  ORDER BY (provider.organization_id IS NOT NULL) DESC
  LIMIT 1
) p ON true
LEFT JOIN workspaces w
  ON w.organization_id = d.organization_id
 AND w.id = d.workspace_id
LEFT JOIN api_keys k
  ON k.organization_id = d.organization_id
 AND k.workspace_id = d.workspace_id
 AND COALESCE(k.routing_config_id, w.default_routing_config_id) = d.routing_config_id
 AND k.access_profile_id IS NULL
 AND k.revoked_at IS NULL
 AND (k.expires_at IS NULL OR k.expires_at > now())
LEFT JOIN api_key_provider_accounts b
  ON b.organization_id = d.organization_id
 AND b.workspace_id = d.workspace_id
 AND b.api_key_id = k.id
 AND b.provider_id = p.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_credential_choices choice
    JOIN provider_accounts account
      ON account.organization_id = choice.organization_id
     AND account.id = choice.requested_provider_account_id
    WHERE choice.credential_kind = 'account'
      AND account.auth_type <> 'api_key'
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover cannot map OAuth provider credentials';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_credential_choices
    GROUP BY organization_id, workspace_id, routing_config_id, provider
    HAVING count(DISTINCT jsonb_build_array(
      credential_kind,
      requested_provider_account_id
    )) > 1
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover cannot preserve heterogeneous provider credentials';
  END IF;
END;
$$;

CREATE TEMP TABLE gateway_legacy_deployments ON COMMIT DROP AS
SELECT DISTINCT ON (d.organization_id, d.workspace_id, d.provider, d.model)
  d.organization_id,
  d.workspace_id,
  d.routing_config_id,
  d.provider,
  d.model,
  d.requested_provider_account_id,
  d.deployment,
  NULLIF(d.deployment ->> 'baseUrl', '') AS deployment_base_url,
  d.classifier,
  d.priority,
  p.id AS legacy_provider_id,
  p.organization_id AS legacy_provider_organization_id,
  p.display_name AS provider_name,
  p.base_url AS provider_base_url,
  p.adapter_kind,
  p.adapter_config,
  p.auth_style,
  p.endpoints,
  p.default_headers,
  p.forward_harness_headers,
  choice.credential_kind,
  choice.requested_provider_account_id AS credential_provider_account_id,
  a.id AS legacy_provider_account_id,
  a.name AS provider_account_name,
  a.base_url AS account_base_url,
  CASE
    WHEN a.id IS NOT NULL THEN a.secret_ref
    WHEN choice.credential_kind = 'platform' AND p.organization_id IS NULL AND d.provider = 'openai'
      THEN 'env:OPENAI_API_KEY'
    WHEN choice.credential_kind = 'platform' AND p.organization_id IS NULL AND d.provider = 'anthropic'
      THEN 'env:ANTHROPIC_API_KEY'
    ELSE NULL
  END AS secret_ref,
  CASE WHEN a.id IS NOT NULL THEN a.secret_ciphertext ELSE NULL END AS secret_ciphertext,
  CASE
    WHEN a.id IS NOT NULL THEN a.secret_hint
    WHEN choice.credential_kind = 'platform' AND p.organization_id IS NULL AND d.provider = 'openai'
      THEN 'OPENAI_API_KEY'
    WHEN choice.credential_kind = 'platform' AND p.organization_id IS NULL AND d.provider = 'anthropic'
      THEN 'ANTHROPIC_API_KEY'
    ELSE NULL
  END AS secret_hint,
  a.auth_type AS account_auth_type,
  a.settings AS account_settings,
  catalog.capabilities AS model_capabilities,
  catalog.pricing AS model_pricing
FROM gateway_legacy_deployment_candidates d
LEFT JOIN LATERAL (
  SELECT provider.*
  FROM providers provider
  WHERE provider.slug = d.provider
    AND (provider.organization_id = d.organization_id OR provider.organization_id IS NULL)
    AND provider.enabled = true
  ORDER BY (provider.organization_id IS NOT NULL) DESC
  LIMIT 1
) p ON true
JOIN gateway_legacy_credential_choices choice
  ON choice.organization_id = d.organization_id
 AND choice.workspace_id = d.workspace_id
 AND choice.routing_config_id = d.routing_config_id
 AND choice.provider = d.provider
LEFT JOIN LATERAL (
  SELECT account.*
  FROM provider_accounts account
  WHERE account.organization_id = d.organization_id
    AND account.provider_id = p.id
    AND account.status = 'active'
    AND choice.credential_kind = 'account'
    AND account.id = choice.requested_provider_account_id
  ORDER BY account.id
  LIMIT 1
) a ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE((
      SELECT jsonb_object_agg(capability.key, capability.value)
      FROM jsonb_each(
        CASE
          WHEN jsonb_typeof(entry.capabilities) = 'object' THEN entry.capabilities
          ELSE '{}'::jsonb
        END
      ) capability
      WHERE CASE jsonb_typeof(capability.value)
        WHEN 'boolean' THEN true
        WHEN 'number' THEN (capability.value #>> '{}')::numeric > 0
        WHEN 'array' THEN NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(capability.value) item
             WHERE jsonb_typeof(item) <> 'string'
        )
        ELSE false
      END
    ), '{}'::jsonb) AS capabilities,
    entry.pricing
  FROM model_catalog entry
  WHERE entry.provider_id = p.id
    AND (entry.organization_id = d.organization_id OR entry.organization_id IS NULL)
    AND (
      entry.provider_account_id IS NULL OR
      entry.provider_account_id = a.id
    )
    AND entry.model IN (
      d.model,
      regexp_replace(d.model, '-([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$', '')
    )
  ORDER BY
    (entry.model = d.model) DESC,
    (entry.organization_id = d.organization_id) DESC,
    (entry.provider_account_id = a.id) DESC
  LIMIT 1
) catalog ON true
ORDER BY
  d.organization_id,
  d.workspace_id,
  d.provider,
  d.model,
  d.classifier DESC,
  d.priority;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments
    WHERE legacy_provider_account_id IS NOT NULL
      AND account_auth_type <> 'api_key'
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover cannot map OAuth provider credentials';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments
    WHERE legacy_provider_id IS NULL
       OR adapter_kind NOT IN ('generic-http-json', 'aws-bedrock-converse')
       OR (
         credential_kind = 'account' AND
         legacy_provider_account_id IS NULL
       )
       OR (
         credential_kind = 'platform' AND
         auth_style NOT IN ('none', 'aws-sdk') AND
         NOT (
           legacy_provider_organization_id IS NULL AND
           provider IN ('openai', 'anthropic')
         )
       )
       OR (
         legacy_provider_account_id IS NOT NULL AND
         auth_style NOT IN ('none', 'aws-sdk') AND
         secret_ref IS NULL AND
         secret_ciphertext IS NULL
       )
       OR (
         adapter_kind = 'aws-bedrock-converse' AND
         legacy_provider_organization_id IS NOT NULL AND
         legacy_provider_account_id IS NULL
       )
       OR (
         adapter_kind = 'aws-bedrock-converse' AND
         credential_kind = 'account' AND
         secret_ref IS NULL AND
         secret_ciphertext IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover could not resolve a provider adapter or credential';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments
    WHERE deployment_base_url IS NOT NULL
      AND deployment_base_url IS DISTINCT FROM COALESCE(account_base_url, provider_base_url)
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover cannot preserve a deployment base URL override';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments
    GROUP BY organization_id, workspace_id, provider
    HAVING count(DISTINCT COALESCE(legacy_provider_account_id, 'none')) > 1
       OR count(DISTINCT COALESCE(account_base_url, provider_base_url)) > 1
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found ambiguous provider accounts in one workspace';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments
    WHERE jsonb_typeof(endpoints) <> 'array' OR jsonb_array_length(endpoints) = 0
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found a provider without endpoints';
  END IF;
END;
$$;

INSERT INTO provider_connections (
  id,
  organization_id,
  workspace_id,
  slug,
  name,
  adapter_kind,
  auth_style,
  base_url,
  region,
  secret_ref,
  secret_ciphertext,
  secret_hint,
  adapter_config,
  default_headers,
  platform_owned,
  forward_harness_headers,
  legacy_provider_account_id,
  status
)
SELECT DISTINCT ON (organization_id, workspace_id, provider)
  workspace_id || ':connection:' || provider,
  organization_id,
  workspace_id,
  provider,
  COALESCE(provider_account_name, provider_name),
  adapter_kind,
  auth_style,
  COALESCE(account_base_url, provider_base_url),
  NULLIF(account_settings ->> 'region', ''),
  secret_ref,
  secret_ciphertext,
  secret_hint,
  CASE
    WHEN adapter_kind = 'aws-bedrock-converse'
      THEN adapter_config || COALESCE(account_settings, '{}'::jsonb)
    ELSE adapter_config
  END,
  default_headers,
  credential_kind = 'platform' AND legacy_provider_organization_id IS NULL,
  forward_harness_headers,
  legacy_provider_account_id,
  'active'
FROM gateway_legacy_deployments
ORDER BY organization_id, workspace_id, provider
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments d
    LEFT JOIN provider_connections c
      ON c.organization_id = d.organization_id
     AND c.workspace_id = d.workspace_id
     AND c.id = d.workspace_id || ':connection:' || d.provider
    WHERE c.id IS NULL
       OR c.slug <> d.provider
       OR c.name <> COALESCE(d.provider_account_name, d.provider_name)
       OR c.adapter_kind <> d.adapter_kind
       OR c.auth_style <> d.auth_style
       OR c.base_url <> COALESCE(d.account_base_url, d.provider_base_url)
       OR c.region IS DISTINCT FROM NULLIF(d.account_settings ->> 'region', '')
       OR c.adapter_config <> CASE
         WHEN d.adapter_kind = 'aws-bedrock-converse'
           THEN d.adapter_config || COALESCE(d.account_settings, '{}'::jsonb)
         ELSE d.adapter_config
       END
       OR c.default_headers <> d.default_headers
       OR c.platform_owned <> (
         d.credential_kind = 'platform' AND d.legacy_provider_organization_id IS NULL
       )
       OR c.forward_harness_headers <> d.forward_harness_headers
       OR c.legacy_provider_account_id IS DISTINCT FROM d.legacy_provider_account_id
       OR c.secret_ref IS DISTINCT FROM d.secret_ref
       OR c.secret_ciphertext IS DISTINCT FROM d.secret_ciphertext
       OR c.secret_hint IS DISTINCT FROM d.secret_hint
       OR c.status <> 'active'
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found a conflicting provider connection';
  END IF;
END;
$$;

INSERT INTO canonical_models (
  id,
  organization_id,
  workspace_id,
  slug,
  name,
  vendor,
  family,
  capabilities,
  status
)
SELECT
  workspace_id || ':canonical:' || provider || ':' || model,
  organization_id,
  workspace_id,
  provider || '--' || model,
  model,
  provider,
  model,
  COALESCE(model_capabilities, '{}'::jsonb),
  'active'
FROM gateway_legacy_deployments
ON CONFLICT DO NOTHING;

INSERT INTO model_deployments (
  id,
  organization_id,
  workspace_id,
  slug,
  name,
  canonical_model_id,
  provider_connection_id,
  upstream_model_id,
  region,
  config,
  capabilities,
  pricing,
  status
)
SELECT
  workspace_id || ':deployment:' || provider || ':' || model,
  organization_id,
  workspace_id,
  provider || '--' || model,
  model,
  workspace_id || ':canonical:' || provider || ':' || model,
  workspace_id || ':connection:' || provider,
  model,
  NULLIF(account_settings ->> 'region', ''),
  deployment - ARRAY[
    'provider',
    'model',
    'baseUrl',
    'providerAccountId',
    'order',
    'weight'
  ]::text[],
  '{}'::jsonb,
  COALESCE(model_pricing, '{}'::jsonb),
  'active'
FROM gateway_legacy_deployments
ON CONFLICT DO NOTHING;

INSERT INTO deployment_wire_bindings (
  id,
  organization_id,
  workspace_id,
  deployment_id,
  provider_connection_id,
  api_wire_id,
  endpoint_path,
  request_config,
  adapter_contract_version,
  enabled
)
SELECT DISTINCT ON (
  d.organization_id,
  d.workspace_id,
  d.provider,
  d.model,
  endpoint ->> 'dialect'
)
  d.workspace_id || ':deployment:' || d.provider || ':' || d.model ||
    ':wire:' || (endpoint ->> 'dialect'),
  d.organization_id,
  d.workspace_id,
  d.workspace_id || ':deployment:' || d.provider || ':' || d.model,
  d.workspace_id || ':connection:' || d.provider,
  endpoint ->> 'dialect',
  CASE
    WHEN endpoint ->> 'dialect' = 'bedrock-converse' THEN NULL
    ELSE endpoint ->> 'path'
  END,
  '{}'::jsonb,
  '1',
  true
FROM gateway_legacy_deployments d
CROSS JOIN LATERAL jsonb_array_elements(d.endpoints) endpoint
WHERE endpoint ->> 'dialect' IN (
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
  'bedrock-converse'
)
ORDER BY
  d.organization_id,
  d.workspace_id,
  d.provider,
  d.model,
  endpoint ->> 'dialect'
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments d
    WHERE NOT EXISTS (
      SELECT 1
      FROM deployment_wire_bindings b
      WHERE b.organization_id = d.organization_id
        AND b.workspace_id = d.workspace_id
        AND b.deployment_id = d.workspace_id || ':deployment:' || d.provider || ':' || d.model
        AND b.enabled = true
    )
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover could not materialize a deployment wire binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments d
    WHERE d.classifier = true
      AND NOT EXISTS (
        SELECT 1
        FROM deployment_wire_bindings b
        WHERE b.organization_id = d.organization_id
          AND b.workspace_id = d.workspace_id
          AND b.deployment_id = d.workspace_id || ':deployment:' || d.provider || ':' || d.model
          AND b.api_wire_id = 'openai-responses'
          AND b.enabled = true
      )
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover classifier requires an OpenAI Responses binding';
  END IF;
END;
$$;

INSERT INTO logical_models (
  id,
  organization_id,
  workspace_id,
  slug,
  name,
  description,
  resolution_kind,
  router_kind,
  router_config,
  status
)
SELECT
  c.workspace_id || ':logical-model:coding-auto',
  c.organization_id,
  c.workspace_id,
  'coding-auto',
  'Coding Auto',
  'Classifier-routed model materialized during the AI gateway cutover.',
  'router',
  'classifier',
  jsonb_build_object(
    'classifierDeploymentId',
      c.workspace_id || ':deployment:' || (c.config #>> '{classifier,providerId}') || ':' ||
        (c.config #>> '{classifier,model}'),
    'instructions',
      'Select exactly one eligible target for this AI gateway request.',
    'timeoutMs',
      COALESCE((c.config #>> '{classifier,timeoutMs}')::integer, 10000),
    'maxAttempts',
      COALESCE((c.config #>> '{classifier,maxAttempts}')::integer, 2)
  ),
  'active'
FROM gateway_legacy_configs c
ON CONFLICT DO NOTHING;

INSERT INTO logical_model_targets (
  id,
  organization_id,
  workspace_id,
  logical_model_id,
  deployment_id,
  priority,
  enabled
)
SELECT
  ranked.workspace_id || ':logical-model:coding-auto:target:' || md5(ranked.deployment_id),
  ranked.organization_id,
  ranked.workspace_id,
  ranked.workspace_id || ':logical-model:coding-auto',
  ranked.deployment_id,
  ranked.target_priority,
  true
FROM (
  SELECT
    d.organization_id,
    d.workspace_id,
    d.workspace_id || ':deployment:' || d.provider || ':' || d.model AS deployment_id,
    row_number() OVER (
      PARTITION BY d.organization_id, d.workspace_id
      ORDER BY min(d.priority), d.provider, d.model
    ) - 1 AS target_priority
  FROM gateway_legacy_deployment_candidates d
  WHERE d.classifier = false
  GROUP BY d.organization_id, d.workspace_id, d.provider, d.model
) ranked
ON CONFLICT DO NOTHING;

INSERT INTO access_profiles (
  id,
  organization_id,
  workspace_id,
  slug,
  name,
  description,
  limits,
  status
)
SELECT
  c.workspace_id || ':access-profile:legacy-' || md5(c.routing_config_id),
  c.organization_id,
  c.workspace_id,
  'legacy-' || md5(c.routing_config_id),
  c.routing_config_name,
  'Access profile materialized during the AI gateway cutover.',
  '{}'::jsonb,
  'active'
FROM gateway_legacy_configs c
ON CONFLICT DO NOTHING;

INSERT INTO access_profile_model_grants (
  id,
  organization_id,
  workspace_id,
  access_profile_id,
  logical_model_id,
  allowed_operations,
  parameter_caps,
  enabled
)
SELECT
  c.workspace_id || ':access-profile:legacy-' || md5(c.routing_config_id) || ':grant:coding-auto',
  c.organization_id,
  c.workspace_id,
  c.workspace_id || ':access-profile:legacy-' || md5(c.routing_config_id),
  c.workspace_id || ':logical-model:coding-auto',
  ARRAY['text.generate', 'text.count_tokens', 'model.list']::text[],
  '{}'::jsonb,
  true
FROM gateway_legacy_configs c
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments d
    LEFT JOIN canonical_models m
      ON m.organization_id = d.organization_id
     AND m.workspace_id = d.workspace_id
     AND m.id = d.workspace_id || ':canonical:' || d.provider || ':' || d.model
    WHERE m.id IS NULL
       OR m.slug <> d.provider || '--' || d.model
       OR m.name <> d.model
       OR m.vendor <> d.provider
       OR m.family <> d.model
       OR m.capabilities <> COALESCE(d.model_capabilities, '{}'::jsonb)
       OR m.status <> 'active'
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found a conflicting canonical model';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments d
    LEFT JOIN model_deployments m
      ON m.organization_id = d.organization_id
     AND m.workspace_id = d.workspace_id
     AND m.id = d.workspace_id || ':deployment:' || d.provider || ':' || d.model
    WHERE m.id IS NULL
       OR m.slug <> d.provider || '--' || d.model
       OR m.name <> d.model
       OR m.canonical_model_id <> d.workspace_id || ':canonical:' || d.provider || ':' || d.model
       OR m.provider_connection_id <> d.workspace_id || ':connection:' || d.provider
       OR m.upstream_model_id <> d.model
       OR m.region IS DISTINCT FROM NULLIF(d.account_settings ->> 'region', '')
       OR m.config <> d.deployment - ARRAY[
         'provider', 'model', 'baseUrl', 'providerAccountId', 'order', 'weight'
       ]::text[]
       OR m.capabilities <> '{}'::jsonb
       OR m.pricing <> COALESCE(d.model_pricing, '{}'::jsonb)
       OR m.status <> 'active'
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found a conflicting model deployment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments d
    CROSS JOIN LATERAL jsonb_array_elements(d.endpoints) endpoint
    LEFT JOIN deployment_wire_bindings b
      ON b.organization_id = d.organization_id
     AND b.workspace_id = d.workspace_id
     AND b.id = d.workspace_id || ':deployment:' || d.provider || ':' || d.model ||
       ':wire:' || (endpoint ->> 'dialect')
    WHERE endpoint ->> 'dialect' IN (
      'anthropic-messages', 'openai-responses', 'openai-chat', 'bedrock-converse'
    )
      AND (
        b.id IS NULL
        OR b.deployment_id <> d.workspace_id || ':deployment:' || d.provider || ':' || d.model
        OR b.provider_connection_id <> d.workspace_id || ':connection:' || d.provider
        OR b.api_wire_id <> endpoint ->> 'dialect'
        OR b.endpoint_path IS DISTINCT FROM CASE
          WHEN endpoint ->> 'dialect' = 'bedrock-converse' THEN NULL
          ELSE endpoint ->> 'path'
        END
        OR b.request_config <> '{}'::jsonb
        OR b.adapter_contract_version <> '1'
        OR b.enabled <> true
      )
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found a conflicting deployment wire binding';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_deployments d
    WHERE (
      SELECT count(*)
      FROM deployment_wire_bindings b
      WHERE b.organization_id = d.organization_id
        AND b.workspace_id = d.workspace_id
        AND b.deployment_id = d.workspace_id || ':deployment:' || d.provider || ':' || d.model
        AND b.enabled = true
    ) <> (
      SELECT count(DISTINCT endpoint ->> 'dialect')
      FROM jsonb_array_elements(d.endpoints) endpoint
      WHERE endpoint ->> 'dialect' IN (
        'anthropic-messages', 'openai-responses', 'openai-chat', 'bedrock-converse'
      )
    )
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found unexpected deployment wire bindings';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_configs c
    LEFT JOIN logical_models m
      ON m.organization_id = c.organization_id
     AND m.workspace_id = c.workspace_id
     AND m.id = c.workspace_id || ':logical-model:coding-auto'
    WHERE m.id IS NULL
       OR m.slug <> 'coding-auto'
       OR m.name <> 'Coding Auto'
       OR m.description <> 'Classifier-routed model materialized during the AI gateway cutover.'
       OR m.resolution_kind <> 'router'
       OR m.router_kind <> 'classifier'
       OR m.router_config <> jsonb_build_object(
         'classifierDeploymentId',
           c.workspace_id || ':deployment:' || (c.config #>> '{classifier,providerId}') || ':' ||
             (c.config #>> '{classifier,model}'),
         'instructions', 'Select exactly one eligible target for this AI gateway request.',
         'timeoutMs', COALESCE((c.config #>> '{classifier,timeoutMs}')::integer, 10000),
         'maxAttempts', COALESCE((c.config #>> '{classifier,maxAttempts}')::integer, 2)
       )
       OR m.status <> 'active'
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found a conflicting logical model';
  END IF;

  IF EXISTS (
    WITH expected AS (
      SELECT
        ranked.organization_id,
        ranked.workspace_id,
        ranked.workspace_id || ':logical-model:coding-auto:target:' || md5(ranked.deployment_id) AS id,
        ranked.deployment_id,
        ranked.target_priority
      FROM (
        SELECT
          d.organization_id,
          d.workspace_id,
          d.workspace_id || ':deployment:' || d.provider || ':' || d.model AS deployment_id,
          row_number() OVER (
            PARTITION BY d.organization_id, d.workspace_id
            ORDER BY min(d.priority), d.provider, d.model
          ) - 1 AS target_priority
        FROM gateway_legacy_deployment_candidates d
        WHERE d.classifier = false
        GROUP BY d.organization_id, d.workspace_id, d.provider, d.model
      ) ranked
    )
    SELECT 1
    FROM expected e
    LEFT JOIN logical_model_targets t
      ON t.organization_id = e.organization_id
     AND t.workspace_id = e.workspace_id
     AND t.id = e.id
    WHERE t.id IS NULL
       OR t.logical_model_id <> e.workspace_id || ':logical-model:coding-auto'
       OR t.deployment_id <> e.deployment_id
       OR t.priority <> e.target_priority
       OR t.enabled <> true
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found a conflicting logical model target';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_configs c
    WHERE (
      SELECT count(*)
      FROM logical_model_targets t
      WHERE t.organization_id = c.organization_id
        AND t.workspace_id = c.workspace_id
        AND t.logical_model_id = c.workspace_id || ':logical-model:coding-auto'
        AND t.enabled = true
    ) <> (
      SELECT count(*)
      FROM (
        SELECT d.provider, d.model
        FROM gateway_legacy_deployment_candidates d
        WHERE d.organization_id = c.organization_id
          AND d.workspace_id = c.workspace_id
          AND d.classifier = false
        GROUP BY d.provider, d.model
      ) expected_targets
    )
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found unexpected logical model targets';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_configs c
    LEFT JOIN access_profiles p
      ON p.organization_id = c.organization_id
     AND p.workspace_id = c.workspace_id
     AND p.id = c.workspace_id || ':access-profile:legacy-' || md5(c.routing_config_id)
    WHERE p.id IS NULL
       OR p.slug <> 'legacy-' || md5(c.routing_config_id)
       OR p.name <> c.routing_config_name
       OR p.description <> 'Access profile materialized during the AI gateway cutover.'
       OR p.limits <> '{}'::jsonb
       OR p.status <> 'active'
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found a conflicting access profile';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_configs c
    LEFT JOIN access_profile_model_grants g
      ON g.organization_id = c.organization_id
     AND g.workspace_id = c.workspace_id
     AND g.id = c.workspace_id || ':access-profile:legacy-' || md5(c.routing_config_id) ||
       ':grant:coding-auto'
    WHERE g.id IS NULL
       OR g.access_profile_id <> c.workspace_id || ':access-profile:legacy-' || md5(c.routing_config_id)
       OR g.logical_model_id <> c.workspace_id || ':logical-model:coding-auto'
       OR g.allowed_operations <> ARRAY['text.generate', 'text.count_tokens', 'model.list']::text[]
       OR g.parameter_caps <> '{}'::jsonb
       OR g.enabled <> true
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found a conflicting access profile grant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_configs c
    WHERE (
      SELECT count(*)
      FROM access_profile_model_grants g
      WHERE g.organization_id = c.organization_id
        AND g.workspace_id = c.workspace_id
        AND g.access_profile_id = c.workspace_id || ':access-profile:legacy-' || md5(c.routing_config_id)
        AND g.enabled = true
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover found unexpected access profile grants';
  END IF;
END;
$$;

UPDATE api_keys k
SET access_profile_id =
  k.workspace_id || ':access-profile:legacy-' || md5(c.routing_config_id)
FROM gateway_legacy_configs c
JOIN workspaces w
  ON w.organization_id = c.organization_id
 AND w.id = c.workspace_id
WHERE k.organization_id = c.organization_id
  AND k.workspace_id = c.workspace_id
  AND COALESCE(k.routing_config_id, w.default_routing_config_id) = c.routing_config_id
  AND k.access_profile_id IS NULL
  AND k.revoked_at IS NULL
  AND (k.expires_at IS NULL OR k.expires_at > now());

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM api_keys
    WHERE revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND access_profile_id IS NULL
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover left an active API key without an access profile';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM gateway_legacy_configs c
    WHERE NOT EXISTS (
      SELECT 1
      FROM logical_model_targets t
      WHERE t.organization_id = c.organization_id
        AND t.workspace_id = c.workspace_id
        AND t.logical_model_id = c.workspace_id || ':logical-model:coding-auto'
        AND t.enabled = true
    )
  ) THEN
    RAISE EXCEPTION 'AI gateway cutover produced a logical model without targets';
  END IF;
END;
$$;
