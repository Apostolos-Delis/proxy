-- Workspaces: one organization -> many workspaces -> traffic-scoped resources
-- (API keys, routing configs, sessions, requests, usage, prompts). Existing
-- rows migrate into a deterministic default workspace per organization.

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  default_routing_config_id text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_org_slug_idx ON workspaces (organization_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_org_id_idx ON workspaces (organization_id, id);

INSERT INTO workspaces (id, organization_id, slug, name)
SELECT o.id || ':workspace:default', o.id, 'default', 'Default'
FROM organizations o
ON CONFLICT DO NOTHING;

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL;

ALTER TABLE routing_configs ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE routing_config_versions ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE api_key_provider_accounts ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE turns ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE route_decisions ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE provider_attempts ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE prompt_artifacts ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE prompt_access_audit ADD COLUMN IF NOT EXISTS workspace_id text;
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL;

UPDATE routing_configs SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE routing_config_versions SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE api_keys SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE api_key_provider_accounts SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE agent_sessions SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE turns SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE requests SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE route_decisions SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE provider_attempts SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE usage_ledger SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE prompt_artifacts SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;
UPDATE prompt_access_audit SET workspace_id = organization_id || ':workspace:default' WHERE workspace_id IS NULL;

-- Traffic and workspace-entity events move into the default workspace;
-- org-level events (invitations, members, users, provider accounts) stay NULL.
UPDATE events SET workspace_id = organization_id || ':workspace:default'
WHERE workspace_id IS NULL
  AND scope_type IN ('request', 'session', 'api_key', 'routing_config');

ALTER TABLE routing_configs
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT routing_configs_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE routing_config_versions
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT routing_config_versions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE api_keys
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT api_keys_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE api_key_provider_accounts
  ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE agent_sessions
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT agent_sessions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE turns
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT turns_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE requests
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT requests_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE route_decisions
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT route_decisions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE provider_attempts
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT provider_attempts_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE usage_ledger
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT usage_ledger_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE prompt_artifacts
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT prompt_artifacts_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE prompt_access_audit
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT prompt_access_audit_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- Composite targets so same-workspace references can be enforced.
CREATE UNIQUE INDEX IF NOT EXISTS routing_configs_org_workspace_id_idx ON routing_configs (organization_id, workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_org_workspace_id_idx ON api_keys (organization_id, workspace_id, id);

-- Rewire same-org reference integrity to same-workspace integrity.
ALTER TABLE routing_config_versions DROP CONSTRAINT IF EXISTS routing_config_versions_config_fk;
ALTER TABLE routing_config_versions
  ADD CONSTRAINT routing_config_versions_config_fk FOREIGN KEY (organization_id, workspace_id, routing_config_id)
  REFERENCES routing_configs(organization_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_routing_config_fk;
ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_routing_config_fk FOREIGN KEY (organization_id, workspace_id, routing_config_id)
  REFERENCES routing_configs(organization_id, workspace_id, id);

ALTER TABLE api_key_provider_accounts DROP CONSTRAINT IF EXISTS api_key_provider_accounts_api_key_id_fkey;
ALTER TABLE api_key_provider_accounts
  ADD CONSTRAINT api_key_provider_accounts_api_key_fk FOREIGN KEY (organization_id, workspace_id, api_key_id)
  REFERENCES api_keys(organization_id, workspace_id, id) ON DELETE CASCADE;

-- The org-level default routing config becomes the default workspace's default.
UPDATE workspaces w
SET default_routing_config_id = os.default_routing_config_id
FROM organization_settings os
WHERE os.organization_id = w.organization_id
  AND w.id = w.organization_id || ':workspace:default'
  AND os.default_routing_config_id IS NOT NULL;

ALTER TABLE organization_settings DROP CONSTRAINT IF EXISTS organization_settings_default_routing_config_fk;
ALTER TABLE organization_settings DROP COLUMN IF EXISTS default_routing_config_id;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_default_routing_config_fk FOREIGN KEY (organization_id, id, default_routing_config_id)
  REFERENCES routing_configs(organization_id, workspace_id, id);

-- Workspace-scoped uniqueness and hot-path indexes replace org-scoped ones.
DROP INDEX IF EXISTS routing_configs_org_slug_idx;
CREATE UNIQUE INDEX IF NOT EXISTS routing_configs_org_workspace_slug_idx ON routing_configs (organization_id, workspace_id, slug);
DROP INDEX IF EXISTS routing_configs_org_id_idx;

DROP INDEX IF EXISTS routing_config_versions_org_hash_idx;
CREATE UNIQUE INDEX IF NOT EXISTS routing_config_versions_org_workspace_hash_idx ON routing_config_versions (organization_id, workspace_id, config_hash);

DROP INDEX IF EXISTS agent_sessions_org_surface_external_idx;
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_org_workspace_surface_external_idx ON agent_sessions (organization_id, workspace_id, surface, external_session_id);

DROP INDEX IF EXISTS requests_organization_created_idx;
CREATE INDEX IF NOT EXISTS requests_org_workspace_created_idx ON requests (organization_id, workspace_id, created_at);

DROP INDEX IF EXISTS route_decisions_final_route_idx;
CREATE INDEX IF NOT EXISTS route_decisions_final_route_idx ON route_decisions (organization_id, workspace_id, final_route);

DROP INDEX IF EXISTS provider_attempts_model_idx;
CREATE INDEX IF NOT EXISTS provider_attempts_model_idx ON provider_attempts (organization_id, workspace_id, provider, model);

DROP INDEX IF EXISTS usage_ledger_org_created_idx;
CREATE INDEX IF NOT EXISTS usage_ledger_org_workspace_created_idx ON usage_ledger (organization_id, workspace_id, created_at);
DROP INDEX IF EXISTS usage_ledger_user_created_idx;
CREATE INDEX IF NOT EXISTS usage_ledger_user_created_idx ON usage_ledger (organization_id, workspace_id, user_id, created_at);
DROP INDEX IF EXISTS usage_ledger_model_idx;
CREATE INDEX IF NOT EXISTS usage_ledger_model_idx ON usage_ledger (organization_id, workspace_id, provider, model);

DROP INDEX IF EXISTS prompt_artifacts_org_created_idx;
CREATE INDEX IF NOT EXISTS prompt_artifacts_org_workspace_created_idx ON prompt_artifacts (organization_id, workspace_id, created_at);

CREATE INDEX IF NOT EXISTS events_org_workspace_created_idx ON events (organization_id, workspace_id, created_at);
