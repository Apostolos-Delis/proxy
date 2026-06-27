ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS catalog_source text NOT NULL DEFAULT 'manual';

UPDATE model_catalog
SET catalog_source = CASE
  WHEN organization_id IS NULL AND capabilities->>'source' = 'models.dev-refresh' THEN 'models.dev-refresh'
  WHEN organization_id IS NULL AND pricing->>'source' = 'models.dev-refresh' THEN 'models.dev-refresh'
  WHEN organization_id IS NULL AND capabilities->>'source' = 'models.dev-snapshot' THEN 'models.dev-snapshot'
  WHEN organization_id IS NULL AND pricing->>'source' = 'env' THEN 'env'
  WHEN organization_id IS NULL THEN 'models.dev-snapshot'
  ELSE 'manual'
END;

ALTER TABLE model_catalog
  ADD CONSTRAINT model_catalog_source_check CHECK (catalog_source IN ('models.dev-snapshot', 'models.dev-refresh', 'env', 'manual'));
