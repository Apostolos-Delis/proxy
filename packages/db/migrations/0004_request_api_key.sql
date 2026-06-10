ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS api_key_id text REFERENCES api_keys(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS requests_api_key_idx ON requests (organization_id, api_key_id);
