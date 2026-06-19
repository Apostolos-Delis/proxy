ALTER TABLE provider_attempts
  ADD COLUMN provider_account_id text;

CREATE INDEX IF NOT EXISTS provider_attempts_org_provider_account_idx
  ON provider_attempts (organization_id, provider_account_id);

ALTER TABLE provider_attempts
  ADD CONSTRAINT provider_attempts_provider_account_fk
  FOREIGN KEY (organization_id, provider_account_id)
  REFERENCES provider_accounts(organization_id, id);
