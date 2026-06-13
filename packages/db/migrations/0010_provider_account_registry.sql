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

ALTER TABLE provider_accounts
  ADD COLUMN provider_id uuid,
  ADD COLUMN base_url text;

UPDATE provider_accounts account
SET provider_id = provider.id
FROM providers provider
WHERE account.provider_id IS NULL
  AND provider.organization_id IS NULL
  AND provider.slug = account.provider;

ALTER TABLE provider_accounts
  ALTER COLUMN provider_id SET NOT NULL,
  ADD CONSTRAINT provider_accounts_provider_id_fk FOREIGN KEY (provider_id) REFERENCES providers(id);

DROP INDEX IF EXISTS provider_accounts_org_provider_name_idx;
CREATE UNIQUE INDEX provider_accounts_org_provider_id_name_idx
  ON provider_accounts (organization_id, provider_id, name)
  WHERE status = 'active';

ALTER TABLE api_key_provider_accounts
  ADD COLUMN provider_id uuid;

UPDATE api_key_provider_accounts binding
SET provider_id = provider.id
FROM providers provider
WHERE binding.provider_id IS NULL
  AND provider.organization_id IS NULL
  AND provider.slug = binding.provider;

ALTER TABLE api_key_provider_accounts
  ALTER COLUMN provider_id SET NOT NULL,
  ADD CONSTRAINT api_key_provider_accounts_provider_id_fk FOREIGN KEY (provider_id) REFERENCES providers(id);

ALTER TABLE api_key_provider_accounts DROP CONSTRAINT IF EXISTS api_key_provider_accounts_pk;
ALTER TABLE api_key_provider_accounts
  ADD CONSTRAINT api_key_provider_accounts_pk PRIMARY KEY (organization_id, api_key_id, provider_id);

ALTER TABLE provider_accounts DROP COLUMN provider;
ALTER TABLE api_key_provider_accounts DROP COLUMN provider;
