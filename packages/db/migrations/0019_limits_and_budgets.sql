CREATE TABLE api_key_limit_policies (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  api_key_id text NOT NULL,
  policy jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT api_key_limit_policies_api_key_fk FOREIGN KEY (organization_id, workspace_id, api_key_id)
    REFERENCES api_keys(organization_id, workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX api_key_limit_policies_org_workspace_api_key_idx
  ON api_key_limit_policies (organization_id, workspace_id, api_key_id);

CREATE TABLE workspace_limit_policies (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  policy jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT workspace_limit_policies_workspace_fk FOREIGN KEY (organization_id, workspace_id)
    REFERENCES workspaces(organization_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX workspace_limit_policies_org_workspace_idx
  ON workspace_limit_policies (organization_id, workspace_id);

CREATE TABLE budget_windows (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  window_type text NOT NULL,
  period_start_at timestamp with time zone NOT NULL,
  period_end_at timestamp with time zone NOT NULL,
  limit_usd numeric(18, 6) NOT NULL,
  reserved_usd numeric(18, 6) NOT NULL DEFAULT 0,
  actual_usd numeric(18, 6) NOT NULL DEFAULT 0,
  warning_emitted_at timestamp with time zone,
  exceeded_emitted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT budget_windows_period_order_check CHECK (period_end_at > period_start_at),
  CONSTRAINT budget_windows_limit_usd_positive_check CHECK (limit_usd > 0),
  CONSTRAINT budget_windows_reserved_usd_nonnegative_check CHECK (reserved_usd >= 0),
  CONSTRAINT budget_windows_actual_usd_nonnegative_check CHECK (actual_usd >= 0),
  CONSTRAINT budget_windows_workspace_fk FOREIGN KEY (organization_id, workspace_id)
    REFERENCES workspaces(organization_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX budget_windows_scope_window_start_idx
  ON budget_windows (organization_id, workspace_id, scope_type, scope_id, window_type, period_start_at);
CREATE INDEX budget_windows_org_workspace_period_end_idx
  ON budget_windows (organization_id, workspace_id, period_end_at);

CREATE TABLE budget_reservations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  window_type text NOT NULL,
  period_start_at timestamp with time zone NOT NULL,
  period_end_at timestamp with time zone NOT NULL,
  reserved_usd numeric(18, 6) NOT NULL,
  released_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT budget_reservations_period_order_check CHECK (period_end_at > period_start_at),
  CONSTRAINT budget_reservations_reserved_usd_positive_check CHECK (reserved_usd > 0),
  CONSTRAINT budget_reservations_workspace_fk FOREIGN KEY (organization_id, workspace_id)
    REFERENCES workspaces(organization_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX budget_reservations_request_window_idx
  ON budget_reservations (organization_id, workspace_id, request_id, scope_type, scope_id, window_type, period_start_at);
CREATE INDEX budget_reservations_release_idx
  ON budget_reservations (organization_id, workspace_id, request_id, released_at);

CREATE TABLE active_request_limits (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  api_key_id text,
  provider_account_id text,
  request_id text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT active_request_limits_expiry_check CHECK (expires_at > started_at),
  CONSTRAINT active_request_limits_api_key_fk FOREIGN KEY (organization_id, workspace_id, api_key_id)
    REFERENCES api_keys(organization_id, workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT active_request_limits_provider_account_fk FOREIGN KEY (organization_id, provider_account_id)
    REFERENCES provider_accounts(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT active_request_limits_workspace_fk FOREIGN KEY (organization_id, workspace_id)
    REFERENCES workspaces(organization_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX active_request_limits_request_id_idx
  ON active_request_limits (request_id);
CREATE INDEX active_request_limits_org_workspace_api_key_idx
  ON active_request_limits (organization_id, workspace_id, api_key_id);
CREATE INDEX active_request_limits_provider_account_idx
  ON active_request_limits (organization_id, provider_account_id);
CREATE INDEX active_request_limits_expires_at_idx
  ON active_request_limits (expires_at);
