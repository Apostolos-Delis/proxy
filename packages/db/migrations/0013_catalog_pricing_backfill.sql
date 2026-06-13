WITH catalog_pricing(provider_slug, model, pricing) AS (
  VALUES
    ('openai', 'gpt-5-nano', '{"source":"models.dev-snapshot","inputCostPerMtok":0.05,"outputCostPerMtok":0.4}'::jsonb),
    ('openai', 'gpt-5-nano-2025-08-07', '{"source":"models.dev-snapshot","inputCostPerMtok":0.05,"outputCostPerMtok":0.4}'::jsonb),
    ('openai', 'gpt-5.4-mini', '{"source":"models.dev-snapshot","inputCostPerMtok":0.25,"outputCostPerMtok":2}'::jsonb),
    ('openai', 'gpt-5.4', '{"source":"models.dev-snapshot","inputCostPerMtok":1.25,"outputCostPerMtok":10}'::jsonb),
    ('openai', 'gpt-5.5', '{"source":"models.dev-snapshot","inputCostPerMtok":1.25,"outputCostPerMtok":10}'::jsonb),
    ('openai', 'gpt-5.5-pro', '{"source":"models.dev-snapshot","inputCostPerMtok":15,"outputCostPerMtok":120}'::jsonb),
    ('anthropic', 'claude-fable-5', '{"source":"models.dev-snapshot","inputCostPerMtok":10,"outputCostPerMtok":50}'::jsonb),
    ('anthropic', 'claude-haiku-4-5', '{"source":"models.dev-snapshot","inputCostPerMtok":1,"outputCostPerMtok":5}'::jsonb),
    ('anthropic', 'claude-sonnet-4-5', '{"source":"models.dev-snapshot","inputCostPerMtok":3,"outputCostPerMtok":15}'::jsonb),
    ('anthropic', 'claude-sonnet-4-6', '{"source":"models.dev-snapshot","inputCostPerMtok":3,"outputCostPerMtok":15}'::jsonb),
    ('anthropic', 'claude-opus-4-5', '{"source":"models.dev-snapshot","inputCostPerMtok":5,"outputCostPerMtok":25}'::jsonb),
    ('anthropic', 'claude-opus-4-6', '{"source":"models.dev-snapshot","inputCostPerMtok":5,"outputCostPerMtok":25}'::jsonb),
    ('anthropic', 'claude-opus-4-7', '{"source":"models.dev-snapshot","inputCostPerMtok":5,"outputCostPerMtok":25}'::jsonb),
    ('anthropic', 'claude-opus-4-8', '{"source":"models.dev-snapshot","inputCostPerMtok":5,"outputCostPerMtok":25}'::jsonb)
)
INSERT INTO model_catalog (
  id,
  organization_id,
  provider_id,
  model,
  capabilities,
  pricing,
  created_at,
  updated_at
)
SELECT
  'model:' || catalog_pricing.provider_slug || ':' || regexp_replace(lower(catalog_pricing.model), '[^a-z0-9]+', '-', 'g'),
  NULL,
  providers.id,
  catalog_pricing.model,
  '{}'::jsonb,
  catalog_pricing.pricing,
  now(),
  now()
FROM catalog_pricing
JOIN providers
  ON providers.organization_id IS NULL
  AND providers.slug = catalog_pricing.provider_slug
ON CONFLICT (organization_id, provider_id, model) DO UPDATE
SET pricing = excluded.pricing,
    updated_at = now();
