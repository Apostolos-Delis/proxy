CREATE TABLE provider_connection_health (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  provider_connection_id text NOT NULL,
  status text NOT NULL,
  last_error_type text,
  last_error_message text,
  last_error_at timestamptz,
  cooldown_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_checked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT provider_connection_health_workspace_fk
    FOREIGN KEY (organization_id, workspace_id)
    REFERENCES workspaces(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT provider_connection_health_connection_fk
    FOREIGN KEY (organization_id, workspace_id, provider_connection_id)
    REFERENCES provider_connections(organization_id, workspace_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX provider_connection_health_scope_idx
  ON provider_connection_health (organization_id, workspace_id, provider_connection_id);
CREATE INDEX provider_connection_health_cooldown_idx
  ON provider_connection_health (organization_id, workspace_id, cooldown_until);

CREATE TABLE deployment_health (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  deployment_id text NOT NULL,
  provider_connection_id text NOT NULL,
  status text NOT NULL,
  last_error_type text,
  last_error_at timestamptz,
  lockout_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT deployment_health_workspace_fk
    FOREIGN KEY (organization_id, workspace_id)
    REFERENCES workspaces(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT deployment_health_deployment_fk
    FOREIGN KEY (organization_id, workspace_id, deployment_id, provider_connection_id)
    REFERENCES model_deployments(organization_id, workspace_id, id, provider_connection_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX deployment_health_scope_idx
  ON deployment_health (organization_id, workspace_id, deployment_id);
CREATE INDEX deployment_health_lockout_idx
  ON deployment_health (organization_id, workspace_id, lockout_until);

INSERT INTO provider_connection_health (
  id,
  organization_id,
  workspace_id,
  provider_connection_id,
  status,
  last_error_type,
  last_error_message,
  last_error_at,
  cooldown_until,
  consecutive_failures,
  last_success_at,
  last_checked_at,
  metadata
)
SELECT DISTINCT ON (connection.organization_id, connection.workspace_id, connection.id)
  'connection_health:' || connection.id,
  connection.organization_id,
  connection.workspace_id,
  connection.id,
  health.status,
  health.last_error_type,
  health.last_error_message,
  health.last_error_at,
  health.cooldown_until,
  health.consecutive_failures,
  health.last_success_at,
  health.last_checked_at,
  health.metadata
FROM provider_account_health health
JOIN provider_accounts account
  ON account.organization_id = health.organization_id
 AND account.id = health.provider_account_id
JOIN providers provider
  ON provider.id = account.provider_id
JOIN provider_connections connection
  ON connection.organization_id = health.organization_id
 AND connection.legacy_provider_account_id = account.id
 AND connection.slug = provider.slug
 AND (health.workspace_id IS NULL OR connection.workspace_id = health.workspace_id)
ORDER BY
  connection.organization_id,
  connection.workspace_id,
  connection.id,
  health.last_checked_at DESC NULLS LAST;

INSERT INTO deployment_health (
  id,
  organization_id,
  workspace_id,
  deployment_id,
  provider_connection_id,
  status,
  last_error_type,
  last_error_at,
  lockout_until,
  consecutive_failures,
  last_success_at,
  metadata
)
SELECT DISTINCT ON (deployment.organization_id, deployment.workspace_id, deployment.id)
  'deployment_health:' || deployment.id,
  deployment.organization_id,
  deployment.workspace_id,
  deployment.id,
  deployment.provider_connection_id,
  health.status,
  health.last_error_type,
  health.last_error_at,
  health.lockout_until,
  health.consecutive_failures,
  health.last_success_at,
  health.metadata
FROM provider_model_health health
JOIN provider_accounts account
  ON account.organization_id = health.organization_id
 AND account.id = health.provider_account_id
JOIN providers provider
  ON provider.id = account.provider_id
JOIN provider_connections connection
  ON connection.organization_id = health.organization_id
 AND connection.legacy_provider_account_id = account.id
 AND connection.slug = provider.slug
 AND (health.workspace_id IS NULL OR connection.workspace_id = health.workspace_id)
JOIN model_deployments deployment
  ON deployment.organization_id = connection.organization_id
 AND deployment.workspace_id = connection.workspace_id
 AND deployment.provider_connection_id = connection.id
 AND deployment.upstream_model_id = health.model
ORDER BY
  deployment.organization_id,
  deployment.workspace_id,
  deployment.id,
  health.last_error_at DESC NULLS LAST;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_default_routing_config_fk,
  DROP COLUMN default_routing_config_id;

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_routing_config_fk,
  DROP COLUMN routing_config_id;

ALTER TABLE organization_settings DROP COLUMN max_route;
ALTER TABLE user_settings DROP COLUMN preferred_route;

ALTER TABLE provider_connections DROP COLUMN legacy_provider_account_id;

ALTER TABLE agent_sessions
  DROP COLUMN current_route,
  DROP COLUMN pinned_settings,
  DROP COLUMN routing_config_version_id;

ALTER TABLE requests
  DROP COLUMN routing_config_id,
  DROP COLUMN routing_config_version_id,
  DROP COLUMN routing_config_version,
  DROP COLUMN routing_config_hash;

ALTER TABLE route_decisions
  ADD COLUMN router_decision_id text,
  ADD COLUMN router_decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  DROP COLUMN classifier_route,
  DROP COLUMN final_route,
  DROP COLUMN routing_config_id,
  DROP COLUMN routing_config_version_id,
  DROP COLUMN routing_config_version,
  DROP COLUMN routing_config_hash,
  DROP COLUMN budget_checks,
  DROP COLUMN classifier,
  DROP COLUMN route_execution_plan,
  DROP COLUMN selected_candidate_id;

ALTER TABLE provider_attempts
  DROP CONSTRAINT IF EXISTS provider_attempts_provider_account_fk,
  DROP COLUMN provider_account_id,
  DROP COLUMN route_candidate_id,
  DROP COLUMN attempt_index,
  DROP COLUMN fallback_index,
  DROP COLUMN skip_reason;

ALTER TABLE usage_ledger DROP COLUMN route;
ALTER TABLE prompt_access_audit DROP COLUMN route;

DROP TABLE provider_model_health;
DROP TABLE provider_account_health;
DROP TABLE api_key_provider_accounts;
DROP TABLE model_catalog;
DROP TABLE provider_accounts;
DROP TABLE providers;
DROP TABLE routing_config_versions CASCADE;
DROP TABLE routing_configs;
