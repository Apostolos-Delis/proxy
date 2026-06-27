ALTER TABLE provider_attempts
  ADD COLUMN IF NOT EXISTS adapter_kind text,
  ADD COLUMN IF NOT EXISTS adapter_classification jsonb;

CREATE INDEX IF NOT EXISTS provider_attempts_adapter_kind_idx
  ON provider_attempts (organization_id, workspace_id, adapter_kind);
