CREATE FUNCTION __proxy_v2_anthropic_target(block jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'providerId', 'anthropic',
    'model', block->'model',
    'effort', block#>'{output_config,effort}',
    'thinking', block->'thinking',
    'maxOutputTokens', coalesce(block->'maxOutputTokens', block->'maxTokens'),
    'metadata', block->'metadata'
  ));
$$;

CREATE FUNCTION __proxy_v2_openai_target(block jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'providerId', 'openai',
    'model', block->'model',
    'effort', block#>'{reasoning,effort}',
    'verbosity', block#>'{text,verbosity}',
    'maxOutputTokens', block->'maxOutputTokens',
    'metadata', block->'metadata'
  ));
$$;

CREATE FUNCTION __proxy_v2_route(route jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'description', route->'description',
    'targets', coalesce((
      SELECT jsonb_agg(target)
      FROM (
        SELECT __proxy_v2_anthropic_target(route->'anthropic') AS target
        WHERE route ? 'anthropic' AND route->'anthropic' <> 'null'::jsonb
        UNION ALL
        SELECT __proxy_v2_openai_target(route->'openai') AS target
        WHERE route ? 'openai' AND route->'openai' <> 'null'::jsonb
      ) targets
    ), '[]'::jsonb)
  ));
$$;

CREATE FUNCTION __proxy_v2_config(config jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 2,
    'displayName', config->'displayName',
    'description', config->'description',
    'classifier', jsonb_strip_nulls(jsonb_build_object(
      'providerId', coalesce(config#>'{classifier,providerId}', to_jsonb(coalesce(config#>>'{classifier,provider}', 'openai'))),
      'model', config#>'{classifier,model}',
      'rules', config#>'{classifier,rules}',
      'effort', coalesce(config#>'{classifier,effort}', config#>'{classifier,reasoningEffort}'),
      'timeoutMs', config#>'{classifier,timeoutMs}',
      'maxAttempts', config#>'{classifier,maxAttempts}',
      'allowRedactedExcerpt', config#>'{classifier,allowRedactedExcerpt}',
      'structuredOutput', coalesce(config#>'{classifier,structuredOutput}', '{"mode":"json_schema"}'::jsonb)
    )),
    'routes', jsonb_build_object(
      'fast', __proxy_v2_route(config#>'{routes,fast}'),
      'balanced', __proxy_v2_route(config#>'{routes,balanced}'),
      'hard', __proxy_v2_route(config#>'{routes,hard}'),
      'deep', __proxy_v2_route(config#>'{routes,deep}')
    ),
    'limits', config->'limits',
    'session', config->'session'
  ));
$$;

CREATE TEMP TABLE __proxy_routing_config_v2 ON COMMIT DROP AS
SELECT
  id,
  organization_id,
  workspace_id,
  __proxy_v2_config(config) AS config
FROM routing_config_versions
WHERE config->>'schemaVersion' = '1';

ALTER TABLE __proxy_routing_config_v2
  ADD COLUMN config_hash text;

UPDATE __proxy_routing_config_v2
SET config_hash = encode(sha256(convert_to(config::text, 'UTF8')), 'hex');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT organization_id, workspace_id, config_hash
      FROM routing_config_versions
      WHERE id NOT IN (SELECT id FROM __proxy_routing_config_v2)
      UNION ALL
      SELECT organization_id, workspace_id, config_hash
      FROM __proxy_routing_config_v2
    ) hashes
    GROUP BY organization_id, workspace_id, config_hash
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'routing_config_v2_hash_collision';
  END IF;
END
$$;

UPDATE routing_config_versions version
SET
  config = migrated.config,
  config_hash = migrated.config_hash
FROM __proxy_routing_config_v2 migrated
WHERE version.id = migrated.id;

UPDATE agent_sessions
SET pinned_settings = NULL
WHERE pinned_settings IS NOT NULL;

UPDATE organization_settings
SET settings =
  (settings - 'costBaselineAnthropicModel' - 'costBaselineOpenaiModel') ||
  jsonb_build_object(
    'costBaselineByDialect',
    jsonb_build_object(
      'anthropic-messages', settings->'costBaselineAnthropicModel',
      'openai-responses', settings->'costBaselineOpenaiModel',
      'openai-chat', settings->'costBaselineOpenaiModel'
    )
  )
WHERE settings ? 'costBaselineAnthropicModel'
   OR settings ? 'costBaselineOpenaiModel';

DROP FUNCTION __proxy_v2_config(jsonb);
DROP FUNCTION __proxy_v2_route(jsonb);
DROP FUNCTION __proxy_v2_openai_target(jsonb);
DROP FUNCTION __proxy_v2_anthropic_target(jsonb);
