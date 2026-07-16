CREATE TABLE model_catalog_entries (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  provider text NOT NULL,
  upstream_model_id text NOT NULL,
  canonical_key text NOT NULL,
  canonical_slug text NOT NULL,
  canonical_name text NOT NULL,
  vendor text NOT NULL,
  family text NOT NULL,
  release text,
  region text,
  dialects jsonb NOT NULL,
  canonical_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  deployment_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  pricing jsonb NOT NULL,
  metadata_source jsonb NOT NULL,
  pricing_source jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_catalog_entries_workspace_fk
    FOREIGN KEY (organization_id, workspace_id)
    REFERENCES workspaces(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT model_catalog_entries_status_chk CHECK (status IN ('active', 'disabled')),
  CONSTRAINT model_catalog_entries_dialects_chk
    CHECK (jsonb_typeof(dialects) = 'array' AND jsonb_array_length(dialects) > 0),
  CONSTRAINT model_catalog_entries_metadata_source_chk CHECK (jsonb_typeof(metadata_source) = 'object'),
  CONSTRAINT model_catalog_entries_pricing_source_chk CHECK (jsonb_typeof(pricing_source) = 'object')
);

CREATE UNIQUE INDEX model_catalog_entries_org_workspace_id_idx
  ON model_catalog_entries (organization_id, workspace_id, id);
ALTER TABLE model_catalog_entries
  ADD CONSTRAINT model_catalog_entries_org_workspace_provider_model_region_unique
  UNIQUE NULLS NOT DISTINCT (organization_id, workspace_id, provider, upstream_model_id, region);
CREATE INDEX model_catalog_entries_org_workspace_provider_idx
  ON model_catalog_entries (organization_id, workspace_id, provider);
CREATE INDEX model_catalog_entries_org_workspace_canonical_idx
  ON model_catalog_entries (organization_id, workspace_id, canonical_key);

ALTER TABLE model_deployments ADD COLUMN catalog_entry_id text;

INSERT INTO model_catalog_entries (
  id,
  organization_id,
  workspace_id,
  provider,
  upstream_model_id,
  canonical_key,
  canonical_slug,
  canonical_name,
  vendor,
  family,
  release,
  region,
  dialects,
  canonical_capabilities,
  deployment_capabilities,
  pricing,
  metadata_source,
  pricing_source,
  status
)
SELECT DISTINCT ON (
  deployment.organization_id,
  deployment.workspace_id,
  connection.provider,
  deployment.upstream_model_id,
  deployment.region
)
  deployment.workspace_id || ':catalog:' || connection.provider || ':' || deployment.upstream_model_id || ':' || COALESCE(deployment.region, 'default'),
  deployment.organization_id,
  deployment.workspace_id,
  connection.provider,
  deployment.upstream_model_id,
  canonical.family,
  canonical.family,
  canonical.name,
  canonical.vendor,
  canonical.family,
  canonical.release,
  deployment.region,
  COALESCE((
    SELECT jsonb_agg(binding.api_wire_id ORDER BY binding.api_wire_id)
    FROM deployment_wire_bindings binding
    WHERE binding.organization_id = deployment.organization_id
      AND binding.workspace_id = deployment.workspace_id
      AND binding.deployment_id = deployment.id
      AND binding.enabled = true
  ), CASE connection.provider
    WHEN 'openai' THEN '["openai-responses"]'::jsonb
    WHEN 'amazon-bedrock' THEN '["bedrock-converse"]'::jsonb
    ELSE '["anthropic-messages"]'::jsonb
  END),
  canonical.capabilities,
  deployment.capabilities,
  CASE
    WHEN jsonb_typeof(deployment.pricing->'inputCostPerMtok') = 'number'
      AND jsonb_typeof(deployment.pricing->'outputCostPerMtok') = 'number'
    THEN deployment.pricing - 'source'
    ELSE '{"status":"unpriced"}'::jsonb
  END,
  '{"type":"manual","locator":"migration:0033_source_backed_model_catalog"}'::jsonb,
  CASE deployment.pricing->>'source'
    WHEN 'models.dev-snapshot' THEN '{"type":"models.dev-snapshot","locator":"https://models.dev/api.json"}'::jsonb
    WHEN 'bedrock-curated' THEN '{"type":"provider-documentation","locator":"packages/db/data/bedrock-model-metadata.json"}'::jsonb
    ELSE '{"type":"manual","locator":"migration:0033_source_backed_model_catalog"}'::jsonb
  END,
  deployment.status
FROM model_deployments deployment
JOIN canonical_models canonical
  ON canonical.organization_id = deployment.organization_id
 AND canonical.workspace_id = deployment.workspace_id
 AND canonical.id = deployment.canonical_model_id
JOIN provider_connections connection
  ON connection.organization_id = deployment.organization_id
 AND connection.workspace_id = deployment.workspace_id
 AND connection.id = deployment.provider_connection_id
ORDER BY
  deployment.organization_id,
  deployment.workspace_id,
  connection.provider,
  deployment.upstream_model_id,
  deployment.region,
  deployment.created_at;

UPDATE model_deployments deployment
SET catalog_entry_id = catalog.id
FROM provider_connections connection, model_catalog_entries catalog
WHERE connection.organization_id = deployment.organization_id
  AND connection.workspace_id = deployment.workspace_id
  AND connection.id = deployment.provider_connection_id
  AND catalog.organization_id = deployment.organization_id
  AND catalog.workspace_id = deployment.workspace_id
  AND catalog.provider = connection.provider
  AND catalog.upstream_model_id = deployment.upstream_model_id
  AND catalog.region IS NOT DISTINCT FROM deployment.region;

ALTER TABLE model_deployments
  ADD CONSTRAINT model_deployments_catalog_entry_fk
  FOREIGN KEY (organization_id, workspace_id, catalog_entry_id)
  REFERENCES model_catalog_entries(organization_id, workspace_id, id);

DROP TRIGGER canonical_models_capabilities_trigger ON canonical_models;
DROP FUNCTION prevent_canonical_model_capability_updates();

CREATE FUNCTION enforce_canonical_model_capability_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM model_deployments deployment
    WHERE deployment.organization_id = NEW.organization_id
      AND deployment.workspace_id = NEW.workspace_id
      AND deployment.canonical_model_id = NEW.id
      AND NOT gateway_capabilities_within(NEW.capabilities, deployment.capabilities)
  ) THEN
    RAISE EXCEPTION 'canonical model capabilities must contain linked deployment capabilities'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_models_capabilities_trigger
BEFORE UPDATE OF capabilities
ON canonical_models
FOR EACH ROW EXECUTE FUNCTION enforce_canonical_model_capability_updates();
