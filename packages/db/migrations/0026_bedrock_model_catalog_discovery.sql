ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS provider_account_id text;

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS region text;

DROP INDEX IF EXISTS model_catalog_org_provider_id_model_idx;
DROP INDEX IF EXISTS model_catalog_org_provider_account_model_idx;

CREATE UNIQUE INDEX IF NOT EXISTS model_catalog_org_provider_account_region_model_idx
  ON model_catalog (organization_id, provider_id, provider_account_id, region, model) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS model_catalog_org_provider_account_idx
  ON model_catalog (organization_id, provider_account_id);

ALTER TABLE model_catalog
  DROP CONSTRAINT IF EXISTS model_catalog_provider_account_fk;

ALTER TABLE model_catalog
  ADD CONSTRAINT model_catalog_provider_account_fk
  FOREIGN KEY (organization_id, provider_account_id, provider_id)
  REFERENCES provider_accounts(organization_id, id, provider_id);

ALTER TABLE model_catalog
  DROP CONSTRAINT IF EXISTS model_catalog_source_check;

ALTER TABLE model_catalog
  ADD CONSTRAINT model_catalog_source_check
  CHECK (catalog_source IN ('models.dev-snapshot', 'models.dev-refresh', 'env', 'manual', 'bedrock-discovery'));
