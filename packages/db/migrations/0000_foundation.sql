CREATE TABLE organizations (
  id text PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX organizations_slug_idx ON organizations (slug);

CREATE TABLE users (
  id text PRIMARY KEY,
  email text,
  name text,
  external_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_idx ON users (email);
CREATE UNIQUE INDEX users_external_id_idx ON users (external_id);

CREATE TABLE organization_members (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT organization_members_pk PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX organization_members_user_id_idx ON organization_members (user_id);

CREATE TABLE invitations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  token_hash text NOT NULL,
  token_prefix text NOT NULL,
  invited_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  accepted_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  last_sent_at timestamp with time zone,
  accepted_at timestamp with time zone,
  revoked_at timestamp with time zone
);

CREATE UNIQUE INDEX invitations_token_hash_idx ON invitations (token_hash);
CREATE INDEX invitations_org_email_idx ON invitations (organization_id, email);
CREATE INDEX invitations_org_status_idx ON invitations (organization_id, status);

CREATE TABLE user_sessions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL,
  session_token_prefix text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  last_seen_at timestamp with time zone,
  revoked_at timestamp with time zone
);

CREATE UNIQUE INDEX user_sessions_token_hash_idx ON user_sessions (session_token_hash);
CREATE INDEX user_sessions_organization_user_idx ON user_sessions (organization_id, user_id);
CREATE INDEX user_sessions_expires_at_idx ON user_sessions (expires_at);

CREATE TABLE routing_configs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  active_version_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX routing_configs_org_id_idx ON routing_configs (organization_id, id);
CREATE UNIQUE INDEX routing_configs_org_slug_idx ON routing_configs (organization_id, slug);
CREATE INDEX routing_configs_organization_id_idx ON routing_configs (organization_id);
CREATE INDEX routing_configs_active_version_idx ON routing_configs (organization_id, active_version_id);

CREATE TABLE routing_config_versions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  routing_config_id text NOT NULL,
  version integer NOT NULL,
  config_hash text NOT NULL,
  config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  activated_at timestamp with time zone,
  archived_at timestamp with time zone,
  CONSTRAINT routing_config_versions_config_fk FOREIGN KEY (organization_id, routing_config_id)
    REFERENCES routing_configs(organization_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX routing_config_versions_config_version_idx ON routing_config_versions (organization_id, routing_config_id, version);
CREATE UNIQUE INDEX routing_config_versions_config_id_idx ON routing_config_versions (organization_id, routing_config_id, id);
CREATE UNIQUE INDEX routing_config_versions_org_hash_idx ON routing_config_versions (organization_id, config_hash);
CREATE INDEX routing_config_versions_config_idx ON routing_config_versions (organization_id, routing_config_id);

ALTER TABLE routing_configs
  ADD CONSTRAINT routing_configs_active_version_fk FOREIGN KEY (organization_id, id, active_version_id)
  REFERENCES routing_config_versions(organization_id, routing_config_id, id);

CREATE TABLE api_keys (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  key_hash text NOT NULL,
  name text NOT NULL,
  routing_config_id text,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  last_used_at timestamp with time zone,
  CONSTRAINT api_keys_routing_config_fk FOREIGN KEY (organization_id, routing_config_id)
    REFERENCES routing_configs(organization_id, id)
);

CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash);
CREATE INDEX api_keys_organization_id_idx ON api_keys (organization_id);
CREATE INDEX api_keys_routing_config_idx ON api_keys (organization_id, routing_config_id);

CREATE TABLE organization_settings (
  organization_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  prompt_capture_mode text NOT NULL DEFAULT 'raw_text',
  retention_days integer NOT NULL DEFAULT 30,
  max_route text,
  system_prompt text,
  default_routing_config_id text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT organization_settings_default_routing_config_fk FOREIGN KEY (organization_id, default_routing_config_id)
    REFERENCES routing_configs(organization_id, id)
);

CREATE TABLE user_settings (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preferred_route text,
  max_reasoning_effort text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_settings_pk PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE provider_accounts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  name text NOT NULL,
  auth_type text NOT NULL DEFAULT 'api_key',
  secret_ref text,
  secret_ciphertext text,
  secret_hint text,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  last_used_at timestamp with time zone
);

CREATE UNIQUE INDEX provider_accounts_org_provider_name_idx ON provider_accounts (organization_id, provider, name) WHERE status = 'active';
CREATE UNIQUE INDEX provider_accounts_org_id_idx ON provider_accounts (organization_id, id);
CREATE INDEX provider_accounts_organization_id_idx ON provider_accounts (organization_id);

CREATE TABLE api_key_provider_accounts (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  api_key_id text NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT api_key_provider_accounts_pk PRIMARY KEY (organization_id, api_key_id, provider),
  CONSTRAINT api_key_provider_accounts_account_fk FOREIGN KEY (organization_id, provider_account_id)
    REFERENCES provider_accounts(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX api_key_provider_accounts_account_idx ON api_key_provider_accounts (organization_id, provider_account_id);
CREATE INDEX api_key_provider_accounts_api_key_idx ON api_key_provider_accounts (organization_id, api_key_id);

CREATE TABLE model_catalog (
  id text PRIMARY KEY,
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  route text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  pricing jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX model_catalog_org_provider_model_idx ON model_catalog (organization_id, provider, model);
CREATE INDEX model_catalog_route_idx ON model_catalog (organization_id, route);

CREATE TABLE route_policies (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  classifier_model text NOT NULL,
  classifier_prompt_version text NOT NULL,
  policy jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX route_policies_org_name_idx ON route_policies (organization_id, name);
CREATE INDEX route_policies_organization_id_idx ON route_policies (organization_id);

CREATE TABLE agent_sessions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  surface text NOT NULL,
  external_session_id text,
  current_route text,
  pinned_settings jsonb,
  routing_config_version_id text,
  request_count integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agent_sessions_org_surface_external_idx ON agent_sessions (organization_id, surface, external_session_id);
CREATE INDEX agent_sessions_organization_id_idx ON agent_sessions (organization_id);
CREATE INDEX agent_sessions_user_id_idx ON agent_sessions (organization_id, user_id);

CREATE TABLE turns (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  external_turn_id text,
  status text NOT NULL DEFAULT 'received',
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone
);

CREATE INDEX turns_organization_id_idx ON turns (organization_id);
CREATE INDEX turns_session_id_idx ON turns (session_id);

CREATE TABLE requests (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  turn_id text REFERENCES turns(id) ON DELETE SET NULL,
  api_key_id text REFERENCES api_keys(id) ON DELETE SET NULL,
  surface text NOT NULL,
  idempotency_key text NOT NULL,
  requested_model text NOT NULL,
  input_hash text NOT NULL,
  input_chars integer NOT NULL DEFAULT 0,
  estimated_input_tokens integer,
  routing_input_hash text,
  routing_input_chars integer,
  routing_estimated_input_tokens integer,
  routing_config_id text,
  routing_config_version_id text,
  routing_config_version integer,
  routing_config_hash text,
  status text NOT NULL DEFAULT 'received',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone
);

CREATE UNIQUE INDEX requests_org_idempotency_idx ON requests (organization_id, idempotency_key);
CREATE INDEX requests_organization_created_idx ON requests (organization_id, created_at);
CREATE INDEX requests_session_id_idx ON requests (session_id);
CREATE INDEX requests_user_id_idx ON requests (organization_id, user_id);
CREATE INDEX requests_routing_config_idx ON requests (organization_id, routing_config_id);
CREATE INDEX requests_api_key_idx ON requests (organization_id, api_key_id);

CREATE TABLE route_decisions (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_model text NOT NULL,
  classifier_route text,
  final_route text,
  selected_provider text,
  selected_model text,
  reasoning_effort text,
  verbosity text,
  routing_config_id text,
  routing_config_version_id text,
  routing_config_version integer,
  routing_config_hash text,
  confidence_basis_points integer,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  guardrail_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  classifier jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX route_decisions_request_id_idx ON route_decisions (request_id);
CREATE INDEX route_decisions_organization_id_idx ON route_decisions (organization_id);
CREATE INDEX route_decisions_final_route_idx ON route_decisions (organization_id, final_route);
CREATE INDEX route_decisions_routing_config_idx ON route_decisions (organization_id, routing_config_id);

CREATE TABLE provider_attempts (
  id text PRIMARY KEY,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  surface text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  upstream_request_id text,
  terminal_status text NOT NULL DEFAULT 'pending',
  status_code integer,
  error text,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  first_byte_at timestamp with time zone,
  completed_at timestamp with time zone
);

CREATE INDEX provider_attempts_request_id_idx ON provider_attempts (request_id);
CREATE INDEX provider_attempts_organization_id_idx ON provider_attempts (organization_id);
CREATE INDEX provider_attempts_model_idx ON provider_attempts (organization_id, provider, model);

CREATE TABLE usage_ledger (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  session_id text REFERENCES agent_sessions(id) ON DELETE SET NULL,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  provider_attempt_id text NOT NULL REFERENCES provider_attempts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  route text,
  input_tokens integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  cache_creation_input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  reasoning_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  input_cost_micros integer NOT NULL DEFAULT 0,
  output_cost_micros integer NOT NULL DEFAULT 0,
  total_cost_micros integer NOT NULL DEFAULT 0,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX usage_ledger_provider_attempt_idx ON usage_ledger (provider_attempt_id);
CREATE INDEX usage_ledger_org_created_idx ON usage_ledger (organization_id, created_at);
CREATE INDEX usage_ledger_user_created_idx ON usage_ledger (organization_id, user_id, created_at);
CREATE INDEX usage_ledger_model_idx ON usage_ledger (organization_id, provider, model);

CREATE TABLE prompt_artifacts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  kind text NOT NULL,
  storage_mode text NOT NULL,
  content_hash text NOT NULL,
  raw_text text,
  token_estimate integer,
  source_role text,
  source_index integer,
  redacted_text text,
  encrypted_blob_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX prompt_artifacts_request_id_idx ON prompt_artifacts (request_id);
CREATE INDEX prompt_artifacts_org_created_idx ON prompt_artifacts (organization_id, created_at);
CREATE INDEX prompt_artifacts_content_hash_idx ON prompt_artifacts (organization_id, content_hash);

CREATE TABLE prompt_access_audit (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  artifact_id text NOT NULL REFERENCES prompt_artifacts(id) ON DELETE CASCADE,
  request_id text NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  admin_session_id text REFERENCES user_sessions(id) ON DELETE SET NULL,
  route text,
  access_path text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX prompt_access_audit_org_created_idx ON prompt_access_audit (organization_id, created_at);
CREATE INDEX prompt_access_audit_artifact_idx ON prompt_access_audit (organization_id, artifact_id);
CREATE INDEX prompt_access_audit_user_idx ON prompt_access_audit (organization_id, user_id, created_at);

CREATE TABLE events (
  id text PRIMARY KEY,
  sequence integer NOT NULL,
  schema_version integer NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  session_id text,
  turn_id text,
  parent_event_id text,
  causation_id text,
  correlation_id text,
  idempotency_key text,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  producer text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  sensitivity text NOT NULL,
  redaction_state text NOT NULL,
  payload jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX events_scope_sequence_idx ON events (organization_id, scope_type, scope_id, sequence);
CREATE INDEX events_organization_created_idx ON events (organization_id, created_at);
CREATE INDEX events_scope_created_idx ON events (organization_id, scope_type, scope_id, created_at);
CREATE INDEX events_event_type_idx ON events (organization_id, event_type);
CREATE INDEX events_correlation_id_idx ON events (organization_id, correlation_id);
CREATE INDEX events_idempotency_key_idx ON events (organization_id, idempotency_key);

CREATE TABLE event_outbox (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamp with time zone NOT NULL DEFAULT now(),
  locked_at timestamp with time zone,
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX event_outbox_status_available_idx ON event_outbox (status, available_at);
CREATE INDEX event_outbox_event_id_idx ON event_outbox (event_id);

CREATE TABLE projection_cursors (
  projection_name text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cursor_event_id text,
  cursor_sequence integer,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT projection_cursors_pk PRIMARY KEY (projection_name, organization_id)
);
