CREATE TABLE compression_receipts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  api_key_id text REFERENCES api_keys(id) ON DELETE SET NULL,
  mode text NOT NULL,
  surface text NOT NULL,
  block_path text NOT NULL,
  tool_name text NOT NULL,
  command text,
  command_class text,
  rule_id text NOT NULL,
  rule_version integer NOT NULL,
  status text NOT NULL,
  original_chars integer NOT NULL DEFAULT 0,
  compressed_chars integer NOT NULL DEFAULT 0,
  saved_chars integer NOT NULL DEFAULT 0,
  original_bytes integer NOT NULL DEFAULT 0,
  compressed_bytes integer NOT NULL DEFAULT 0,
  original_estimated_tokens integer NOT NULL DEFAULT 0,
  compressed_estimated_tokens integer NOT NULL DEFAULT 0,
  saved_estimated_tokens integer NOT NULL DEFAULT 0,
  estimate_source text NOT NULL DEFAULT 'rough_chars_per_4',
  original_sha256 text NOT NULL,
  compressed_sha256 text NOT NULL,
  original_artifact_id text REFERENCES prompt_artifacts(id) ON DELETE SET NULL,
  compressed_artifact_id text REFERENCES prompt_artifacts(id) ON DELETE SET NULL,
  skip_reason text,
  event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX compression_receipts_event_block_rule_idx
  ON compression_receipts(event_id, block_path, rule_id, status);

CREATE INDEX compression_receipts_request_id_idx
  ON compression_receipts(request_id);

CREATE INDEX compression_receipts_org_workspace_request_idx
  ON compression_receipts(organization_id, workspace_id, request_id);

CREATE INDEX compression_receipts_api_key_idx
  ON compression_receipts(organization_id, workspace_id, api_key_id);

CREATE INDEX compression_receipts_org_workspace_created_idx
  ON compression_receipts(organization_id, workspace_id, created_at);
