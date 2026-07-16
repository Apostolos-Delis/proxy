ALTER TABLE canonical_models DISABLE TRIGGER canonical_models_capabilities_trigger;

UPDATE canonical_models
SET capabilities = jsonb_set(capabilities, '{contextWindow}', '1000000'::jsonb, true),
  updated_at = now()
WHERE vendor = 'anthropic'
  AND family = 'claude-fable-5'
  AND capabilities->>'contextWindow' = '200000';

ALTER TABLE canonical_models ENABLE TRIGGER canonical_models_capabilities_trigger;
