CREATE TEMP TABLE __proxy_request_input_cap_cutover ON COMMIT DROP AS
SELECT
  id,
  organization_id,
  workspace_id,
  jsonb_set(config, '{limits}', (config->'limits') - 'maxEstimatedInputTokens', false) AS config
FROM routing_config_versions
WHERE config#>>'{limits,maxEstimatedInputTokens}' = '200000';

ALTER TABLE __proxy_request_input_cap_cutover
  ADD COLUMN config_hash text;

UPDATE __proxy_request_input_cap_cutover
SET config_hash = encode(sha256(convert_to(config::text, 'UTF8')), 'hex');

ALTER TABLE __proxy_request_input_cap_cutover
  ADD COLUMN replacement_version_id text;

UPDATE __proxy_request_input_cap_cutover migrated
SET replacement_version_id = existing.id
FROM routing_config_versions existing
WHERE existing.organization_id = migrated.organization_id
  AND existing.workspace_id = migrated.workspace_id
  AND existing.routing_config_id = (
    SELECT capped.routing_config_id
    FROM routing_config_versions capped
    WHERE capped.id = migrated.id
  )
  AND existing.id <> migrated.id
  AND existing.config_hash = migrated.config_hash;

UPDATE routing_config_versions version
SET
  status = 'active',
  activated_at = coalesce(version.activated_at, now())
FROM __proxy_request_input_cap_cutover migrated
JOIN routing_configs config
  ON config.organization_id = migrated.organization_id
  AND config.workspace_id = migrated.workspace_id
  AND config.active_version_id = migrated.id
WHERE version.id = migrated.replacement_version_id;

UPDATE routing_configs config
SET
  active_version_id = migrated.replacement_version_id,
  updated_at = now()
FROM __proxy_request_input_cap_cutover migrated
WHERE config.organization_id = migrated.organization_id
  AND config.workspace_id = migrated.workspace_id
  AND config.active_version_id = migrated.id
  AND migrated.replacement_version_id IS NOT NULL;

UPDATE routing_config_versions version
SET
  config = migrated.config,
  config_hash = migrated.config_hash
FROM __proxy_request_input_cap_cutover migrated
WHERE version.id = migrated.id
  AND migrated.replacement_version_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM routing_config_versions existing
    WHERE existing.organization_id = migrated.organization_id
      AND existing.workspace_id = migrated.workspace_id
      AND existing.id <> migrated.id
      AND existing.config_hash = migrated.config_hash
  )
  AND NOT EXISTS (
    SELECT 1
    FROM __proxy_request_input_cap_cutover other
    WHERE other.organization_id = migrated.organization_id
      AND other.workspace_id = migrated.workspace_id
      AND other.id <> migrated.id
      AND other.config_hash = migrated.config_hash
  );
