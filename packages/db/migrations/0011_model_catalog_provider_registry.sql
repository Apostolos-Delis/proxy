INSERT INTO providers (
  id,
  organization_id,
  slug,
  display_name,
  base_url,
  auth_style,
  endpoints,
  default_headers,
  forward_harness_headers,
  enabled
) VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    NULL,
    'openai',
    'OpenAI',
    'https://api.openai.com/v1',
    'bearer',
    '[{"dialect":"openai-responses","path":"/responses"},{"dialect":"openai-chat","path":"/chat/completions"}]'::jsonb,
    '{}'::jsonb,
    true,
    true
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    NULL,
    'anthropic',
    'Anthropic',
    'https://api.anthropic.com/v1',
    'x-api-key',
    '[{"dialect":"anthropic-messages","path":"/messages"}]'::jsonb,
    '{}'::jsonb,
    true,
    true
  )
ON CONFLICT DO NOTHING;

ALTER TABLE model_catalog
  ADD COLUMN provider_id uuid;

UPDATE model_catalog catalog
SET provider_id = provider.id
FROM providers provider
WHERE catalog.provider_id IS NULL
  AND provider.organization_id IS NULL
  AND provider.slug = catalog.provider;

ALTER TABLE model_catalog
  ALTER COLUMN provider_id SET NOT NULL,
  ADD CONSTRAINT model_catalog_provider_id_fk FOREIGN KEY (provider_id) REFERENCES providers(id);

DROP INDEX IF EXISTS model_catalog_org_provider_model_idx;
CREATE UNIQUE INDEX model_catalog_org_provider_id_model_idx
  ON model_catalog (organization_id, provider_id, model) NULLS NOT DISTINCT;

ALTER TABLE model_catalog DROP COLUMN provider;
