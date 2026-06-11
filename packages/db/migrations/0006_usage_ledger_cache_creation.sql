ALTER TABLE usage_ledger
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens integer NOT NULL DEFAULT 0;
