WITH converted AS (
  SELECT
    id,
    jsonb_set(
      jsonb_set(config, '{schemaVersion}', '2'::jsonb),
      '{routes}',
      (
        SELECT jsonb_object_agg(
          route_key,
          route_value
          || CASE
            WHEN route_value ? 'openai' THEN jsonb_build_object(
              'openai',
              jsonb_build_object(
                'deployments',
                jsonb_build_array(
                  (route_value->'openai')
                  || jsonb_build_object(
                    'provider', 'openai',
                    'order', 0,
                    'weight', 1,
                    'timeoutMs', 60000
                  )
                )
              )
            )
            ELSE '{}'::jsonb
          END
          || CASE
            WHEN route_value ? 'anthropic' THEN jsonb_build_object(
              'anthropic',
              jsonb_build_object(
                'deployments',
                jsonb_build_array(
                  (route_value->'anthropic')
                  || jsonb_build_object(
                    'provider', 'anthropic',
                    'order', 0,
                    'weight', 1,
                    'timeoutMs', 60000
                  )
                )
              )
            )
            ELSE '{}'::jsonb
          END
        )
        FROM jsonb_each(config->'routes') AS routes(route_key, route_value)
      )
    ) AS config
  FROM routing_config_versions
  WHERE config->>'schemaVersion' = '1'
)
UPDATE routing_config_versions
SET
  config = converted.config,
  config_hash = 'v2:' || md5(converted.config::text)
FROM converted
WHERE routing_config_versions.id = converted.id;
