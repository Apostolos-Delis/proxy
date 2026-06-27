ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS adapter_kind text NOT NULL DEFAULT 'generic-http-json',
  ADD COLUMN IF NOT EXISTS adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_auth_style_check,
  ADD CONSTRAINT providers_auth_style_check CHECK (auth_style IN ('bearer', 'x-api-key', 'none', 'aws-sdk')),
  ADD CONSTRAINT providers_adapter_kind_check CHECK (adapter_kind IN ('generic-http-json', 'aws-bedrock-converse'));
