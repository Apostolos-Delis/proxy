ALTER TABLE organization_settings
  ADD COLUMN IF NOT EXISTS system_prompt text;

UPDATE routing_config_versions
  SET config = (config - 'systemPrompt') #- '{classifier,instructions}'
  WHERE config ? 'systemPrompt' OR config -> 'classifier' ? 'instructions';
