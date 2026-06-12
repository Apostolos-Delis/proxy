CREATE INDEX IF NOT EXISTS provider_attempts_org_workspace_request_started_idx
  ON provider_attempts (organization_id, workspace_id, request_id, started_at);

CREATE INDEX IF NOT EXISTS usage_ledger_org_workspace_request_idx
  ON usage_ledger (organization_id, workspace_id, request_id);
