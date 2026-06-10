ALTER TABLE provider_accounts
  ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'api_key',
  ADD COLUMN IF NOT EXISTS secret_ciphertext text,
  ADD COLUMN IF NOT EXISTS secret_hint text,
  ADD COLUMN IF NOT EXISTS created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_used_at timestamp with time zone;

CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_org_id_idx ON provider_accounts (organization_id, id);

-- Scope the provider/name uniqueness to active rows so a revoked credential's
-- label can be reused (e.g. rotating a customer key under the same name).
DROP INDEX IF EXISTS provider_accounts_org_provider_name_idx;
CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_org_provider_name_idx ON provider_accounts (organization_id, provider, name) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS api_key_provider_accounts (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  api_key_id text NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT api_key_provider_accounts_pk PRIMARY KEY (organization_id, api_key_id, provider),
  CONSTRAINT api_key_provider_accounts_account_fk FOREIGN KEY (organization_id, provider_account_id)
    REFERENCES provider_accounts(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS api_key_provider_accounts_account_idx ON api_key_provider_accounts (organization_id, provider_account_id);
CREATE INDEX IF NOT EXISTS api_key_provider_accounts_api_key_idx ON api_key_provider_accounts (organization_id, api_key_id);
