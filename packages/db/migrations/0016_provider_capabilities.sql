ALTER TABLE providers
  ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE providers
SET capabilities = jsonb_build_object('efforts', '["low","medium","high","xhigh"]'::jsonb)
WHERE organization_id IS NULL AND slug = 'openai';

UPDATE providers
SET capabilities = jsonb_build_object('efforts', '["low","medium","high","xhigh","max","ultracode"]'::jsonb)
WHERE organization_id IS NULL AND slug = 'anthropic';
