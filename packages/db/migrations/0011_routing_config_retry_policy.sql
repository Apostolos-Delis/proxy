WITH converted AS (
  SELECT
    id,
    jsonb_set(
      jsonb_set(config, '{schemaVersion}', '3'::jsonb),
      '{routes}',
      (
        SELECT jsonb_object_agg(
          route_key,
          route_value || CASE
            WHEN route_value ? 'retry' THEN '{}'::jsonb
            ELSE jsonb_build_object(
              'retry',
              jsonb_build_object(
                'maxAttempts', 2,
                'retryableStatusCodes', jsonb_build_array(429, 500, 502, 503, 504)
              )
            )
          END
        )
        FROM jsonb_each(config->'routes') AS routes(route_key, route_value)
      )
    ) AS config
  FROM routing_config_versions
  WHERE config->>'schemaVersion' = '2'
)
UPDATE routing_config_versions
SET
  config = converted.config,
  config_hash = 'v3:' || md5(converted.config::text)
FROM converted
WHERE routing_config_versions.id = converted.id;
