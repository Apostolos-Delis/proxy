CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_org_id_provider_id_idx
  ON provider_accounts (organization_id, id, provider_id);

CREATE TABLE IF NOT EXISTS provider_account_health (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text,
  provider_account_id text NOT NULL,
  provider_id uuid NOT NULL REFERENCES providers(id),
  status text NOT NULL,
  last_error_type text,
  last_error_message text,
  last_error_at timestamptz,
  cooldown_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_checked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT provider_account_health_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT provider_account_health_account_fk
    FOREIGN KEY (organization_id, provider_account_id, provider_id) REFERENCES provider_accounts(organization_id, id, provider_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_account_health_org_account_idx
  ON provider_account_health (organization_id, provider_account_id);

CREATE INDEX IF NOT EXISTS provider_account_health_org_provider_idx
  ON provider_account_health (organization_id, provider_id);

CREATE INDEX IF NOT EXISTS provider_account_health_org_cooldown_idx
  ON provider_account_health (organization_id, cooldown_until);

CREATE TABLE IF NOT EXISTS provider_model_health (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text,
  provider_id uuid NOT NULL REFERENCES providers(id),
  provider_account_id text NOT NULL,
  model text NOT NULL,
  status text NOT NULL,
  last_error_type text,
  last_error_at timestamptz,
  lockout_until timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT provider_model_health_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT provider_model_health_account_fk
    FOREIGN KEY (organization_id, provider_account_id, provider_id) REFERENCES provider_accounts(organization_id, id, provider_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_model_health_org_provider_account_model_idx
  ON provider_model_health (organization_id, provider_id, provider_account_id, model);

CREATE INDEX IF NOT EXISTS provider_model_health_org_provider_model_idx
  ON provider_model_health (organization_id, provider_id, model);

CREATE INDEX IF NOT EXISTS provider_model_health_org_lockout_idx
  ON provider_model_health (organization_id, lockout_until);
