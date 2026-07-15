CREATE TABLE logical_models (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  resolution_kind text NOT NULL,
  router_kind text,
  router_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT logical_models_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT logical_models_resolution_chk
    CHECK (
      (resolution_kind = 'direct' AND router_kind IS NULL) OR
      (resolution_kind = 'router' AND router_kind IS NOT NULL AND router_kind = 'classifier')
    ),
  CONSTRAINT logical_models_router_config_chk CHECK (jsonb_typeof(router_config) = 'object'),
  CONSTRAINT logical_models_status_chk CHECK (status IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX logical_models_org_workspace_id_idx
  ON logical_models (organization_id, workspace_id, id);
CREATE UNIQUE INDEX logical_models_org_workspace_slug_idx
  ON logical_models (organization_id, workspace_id, slug);
CREATE INDEX logical_models_org_workspace_status_idx
  ON logical_models (organization_id, workspace_id, status);

CREATE TABLE logical_model_targets (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  logical_model_id text NOT NULL,
  deployment_id text NOT NULL,
  priority integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT logical_model_targets_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT logical_model_targets_logical_model_fk
    FOREIGN KEY (organization_id, workspace_id, logical_model_id)
      REFERENCES logical_models(organization_id, workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT logical_model_targets_deployment_fk
    FOREIGN KEY (organization_id, workspace_id, deployment_id)
      REFERENCES model_deployments(organization_id, workspace_id, id),
  CONSTRAINT logical_model_targets_priority_chk CHECK (priority >= 0)
);

CREATE UNIQUE INDEX logical_model_targets_org_workspace_id_idx
  ON logical_model_targets (organization_id, workspace_id, id);
CREATE UNIQUE INDEX logical_model_targets_org_workspace_model_deployment_idx
  ON logical_model_targets (organization_id, workspace_id, logical_model_id, deployment_id);
CREATE UNIQUE INDEX logical_model_targets_org_workspace_model_priority_idx
  ON logical_model_targets (organization_id, workspace_id, logical_model_id, priority);
CREATE INDEX logical_model_targets_org_workspace_deployment_idx
  ON logical_model_targets (organization_id, workspace_id, deployment_id);

CREATE TABLE access_profiles (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_profiles_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT access_profiles_limits_chk CHECK (
    jsonb_typeof(limits) = 'object' AND
    limits - ARRAY['concurrent_requests', 'requests_per_minute', 'tokens_per_minute']::text[] = '{}'::jsonb AND
    NOT jsonb_path_exists(limits, '$.* ? (@.type() != "number" || @ <= 0 || @.floor() != @)')
  ),
  CONSTRAINT access_profiles_status_chk CHECK (status IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX access_profiles_org_workspace_id_idx
  ON access_profiles (organization_id, workspace_id, id);
CREATE UNIQUE INDEX access_profiles_org_workspace_slug_idx
  ON access_profiles (organization_id, workspace_id, slug);
CREATE INDEX access_profiles_org_workspace_status_idx
  ON access_profiles (organization_id, workspace_id, status);

CREATE TABLE access_profile_model_grants (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  access_profile_id text NOT NULL,
  logical_model_id text NOT NULL,
  allowed_operations text[] NOT NULL,
  parameter_caps jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_profile_model_grants_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT access_profile_model_grants_profile_fk
    FOREIGN KEY (organization_id, workspace_id, access_profile_id)
      REFERENCES access_profiles(organization_id, workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT access_profile_model_grants_logical_model_fk
    FOREIGN KEY (organization_id, workspace_id, logical_model_id)
      REFERENCES logical_models(organization_id, workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT access_profile_model_grants_operations_chk
    CHECK (
      cardinality(allowed_operations) > 0 AND
      allowed_operations <@ ARRAY['text.generate', 'text.count_tokens', 'model.list']::text[]
    ),
  CONSTRAINT access_profile_model_grants_parameter_caps_chk CHECK (
    jsonb_typeof(parameter_caps) = 'object' AND
    parameter_caps - ARRAY['max_tokens', 'max_output_tokens', 'max_completion_tokens']::text[] = '{}'::jsonb AND
    NOT jsonb_path_exists(parameter_caps, '$.* ? (@.type() != "number" || @ < 0 || @.floor() != @)')
  )
);

CREATE UNIQUE INDEX access_profile_model_grants_org_workspace_id_idx
  ON access_profile_model_grants (organization_id, workspace_id, id);
CREATE UNIQUE INDEX access_profile_model_grants_org_workspace_profile_model_idx
  ON access_profile_model_grants (organization_id, workspace_id, access_profile_id, logical_model_id);
CREATE INDEX access_profile_model_grants_org_workspace_model_idx
  ON access_profile_model_grants (organization_id, workspace_id, logical_model_id);

ALTER TABLE api_keys ADD COLUMN access_profile_id text;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_access_profile_fk
  FOREIGN KEY (organization_id, workspace_id, access_profile_id)
    REFERENCES access_profiles(organization_id, workspace_id, id);

CREATE INDEX api_keys_access_profile_idx
  ON api_keys (organization_id, workspace_id, access_profile_id);
