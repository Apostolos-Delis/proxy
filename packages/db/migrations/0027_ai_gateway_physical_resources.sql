CREATE TABLE provider_connections (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  provider text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  adapter_kind text NOT NULL,
  auth_style text NOT NULL,
  base_url text NOT NULL,
  region text,
  secret_ref text,
  secret_ciphertext text,
  secret_hint text,
  adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  platform_owned boolean NOT NULL DEFAULT false,
  forward_harness_headers boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_connections_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT provider_connections_credential_source_chk
    CHECK (NOT (secret_ref IS NOT NULL AND secret_ciphertext IS NOT NULL)),
  CONSTRAINT provider_connections_adapter_auth_chk
    CHECK (
      (adapter_kind = 'generic-http-json' AND auth_style IN ('bearer', 'x-api-key', 'none')) OR
      (adapter_kind = 'aws-bedrock-converse' AND auth_style = 'aws-sdk')
    ),
  CONSTRAINT provider_connections_status_chk
    CHECK (status IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX provider_connections_org_workspace_id_idx
  ON provider_connections (organization_id, workspace_id, id);
CREATE UNIQUE INDEX provider_connections_org_workspace_slug_idx
  ON provider_connections (organization_id, workspace_id, slug);
CREATE INDEX provider_connections_org_workspace_status_idx
  ON provider_connections (organization_id, workspace_id, status);

CREATE TABLE canonical_models (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  vendor text NOT NULL,
  family text NOT NULL,
  release text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT canonical_models_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT canonical_models_status_chk
    CHECK (status IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX canonical_models_org_workspace_id_idx
  ON canonical_models (organization_id, workspace_id, id);
CREATE UNIQUE INDEX canonical_models_org_workspace_slug_idx
  ON canonical_models (organization_id, workspace_id, slug);
CREATE INDEX canonical_models_org_workspace_vendor_family_idx
  ON canonical_models (organization_id, workspace_id, vendor, family);
CREATE INDEX canonical_models_org_workspace_status_idx
  ON canonical_models (organization_id, workspace_id, status);

CREATE TABLE model_deployments (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  canonical_model_id text NOT NULL,
  provider_connection_id text NOT NULL,
  upstream_model_id text NOT NULL,
  region text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  pricing jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_deployments_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT model_deployments_canonical_model_fk
    FOREIGN KEY (organization_id, workspace_id, canonical_model_id)
      REFERENCES canonical_models(organization_id, workspace_id, id),
  CONSTRAINT model_deployments_provider_connection_fk
    FOREIGN KEY (organization_id, workspace_id, provider_connection_id)
      REFERENCES provider_connections(organization_id, workspace_id, id),
  CONSTRAINT model_deployments_status_chk
    CHECK (status IN ('active', 'disabled'))
);

CREATE UNIQUE INDEX model_deployments_org_workspace_id_idx
  ON model_deployments (organization_id, workspace_id, id);
CREATE UNIQUE INDEX model_deployments_org_workspace_id_connection_idx
  ON model_deployments (organization_id, workspace_id, id, provider_connection_id);
CREATE UNIQUE INDEX model_deployments_org_workspace_slug_idx
  ON model_deployments (organization_id, workspace_id, slug);
CREATE INDEX model_deployments_org_workspace_canonical_idx
  ON model_deployments (organization_id, workspace_id, canonical_model_id);
CREATE INDEX model_deployments_org_workspace_connection_idx
  ON model_deployments (organization_id, workspace_id, provider_connection_id);
CREATE INDEX model_deployments_org_workspace_status_idx
  ON model_deployments (organization_id, workspace_id, status);

CREATE TABLE deployment_wire_bindings (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  deployment_id text NOT NULL,
  provider_connection_id text NOT NULL,
  api_wire_id text NOT NULL,
  endpoint_path text,
  request_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  adapter_contract_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_wire_bindings_workspace_fk
    FOREIGN KEY (organization_id, workspace_id) REFERENCES workspaces(organization_id, id) ON DELETE CASCADE,
  CONSTRAINT deployment_wire_bindings_deployment_fk
    FOREIGN KEY (organization_id, workspace_id, deployment_id, provider_connection_id)
      REFERENCES model_deployments(organization_id, workspace_id, id, provider_connection_id)
      ON DELETE CASCADE,
  CONSTRAINT deployment_wire_bindings_api_wire_chk
    CHECK (api_wire_id IN ('anthropic-messages', 'openai-responses', 'openai-chat', 'bedrock-converse')),
  CONSTRAINT deployment_wire_bindings_endpoint_shape_chk
    CHECK (
      (api_wire_id = 'bedrock-converse' AND endpoint_path IS NULL) OR
      (
        api_wire_id <> 'bedrock-converse' AND
        endpoint_path IS NOT NULL AND
        endpoint_path = btrim(endpoint_path) AND
        endpoint_path LIKE '/%'
      )
    ),
  CONSTRAINT deployment_wire_bindings_adapter_version_chk
    CHECK (adapter_contract_version IN ('1'))
);

CREATE UNIQUE INDEX deployment_wire_bindings_org_workspace_id_idx
  ON deployment_wire_bindings (organization_id, workspace_id, id);
CREATE UNIQUE INDEX deployment_wire_bindings_org_workspace_deployment_wire_idx
  ON deployment_wire_bindings (organization_id, workspace_id, deployment_id, api_wire_id);
CREATE INDEX deployment_wire_bindings_org_workspace_connection_idx
  ON deployment_wire_bindings (organization_id, workspace_id, provider_connection_id);

CREATE FUNCTION gateway_capabilities_within(canonical jsonb, deployment jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  capability_name text;
  deployment_value jsonb;
  canonical_value jsonb;
BEGIN
  IF jsonb_typeof(canonical) <> 'object' OR jsonb_typeof(deployment) <> 'object' THEN
    RETURN false;
  END IF;

  FOR capability_name, deployment_value IN SELECT key, value FROM jsonb_each(deployment)
  LOOP
    canonical_value := canonical -> capability_name;
    CASE jsonb_typeof(deployment_value)
      WHEN 'boolean' THEN
        IF deployment_value = 'true'::jsonb AND canonical_value IS DISTINCT FROM 'true'::jsonb THEN
          RETURN false;
        END IF;
      WHEN 'number' THEN
        IF jsonb_typeof(canonical_value) <> 'number' OR
          (deployment_value #>> '{}')::numeric > (canonical_value #>> '{}')::numeric THEN
          RETURN false;
        END IF;
      WHEN 'array' THEN
        IF jsonb_typeof(canonical_value) <> 'array' OR NOT canonical_value @> deployment_value THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
    END CASE;
  END LOOP;

  RETURN true;
END;
$$;

CREATE FUNCTION enforce_model_deployment_capabilities()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_capabilities jsonb;
BEGIN
  SELECT capabilities INTO canonical_capabilities
  FROM canonical_models
  WHERE organization_id = NEW.organization_id
    AND workspace_id = NEW.workspace_id
    AND id = NEW.canonical_model_id;

  IF canonical_capabilities IS NULL OR
    NOT gateway_capabilities_within(canonical_capabilities, NEW.capabilities) THEN
    RAISE EXCEPTION 'model deployment capabilities must narrow canonical capabilities'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER model_deployments_capabilities_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, canonical_model_id, capabilities
ON model_deployments
FOR EACH ROW EXECUTE FUNCTION enforce_model_deployment_capabilities();

CREATE FUNCTION prevent_canonical_model_capability_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.capabilities IS DISTINCT FROM OLD.capabilities THEN
    RAISE EXCEPTION 'canonical model capabilities are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER canonical_models_capabilities_trigger
BEFORE UPDATE OF capabilities
ON canonical_models
FOR EACH ROW EXECUTE FUNCTION prevent_canonical_model_capability_updates();

CREATE FUNCTION prevent_provider_connection_adapter_updates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.adapter_kind IS DISTINCT FROM OLD.adapter_kind THEN
    RAISE EXCEPTION 'provider connection adapter kind is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provider_connections_adapter_kind_trigger
BEFORE UPDATE OF adapter_kind
ON provider_connections
FOR EACH ROW EXECUTE FUNCTION prevent_provider_connection_adapter_updates();

CREATE FUNCTION enforce_deployment_wire_adapter_compatibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  connection_adapter_kind text;
BEGIN
  SELECT adapter_kind INTO connection_adapter_kind
  FROM provider_connections
  WHERE organization_id = NEW.organization_id
    AND workspace_id = NEW.workspace_id
    AND id = NEW.provider_connection_id;

  IF connection_adapter_kind IS NULL OR
    (NEW.api_wire_id = 'bedrock-converse') <> (connection_adapter_kind = 'aws-bedrock-converse') THEN
    RAISE EXCEPTION 'deployment wire is incompatible with provider connection adapter'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER deployment_wire_bindings_adapter_trigger
BEFORE INSERT OR UPDATE OF organization_id, workspace_id, provider_connection_id, api_wire_id
ON deployment_wire_bindings
FOR EACH ROW EXECUTE FUNCTION enforce_deployment_wire_adapter_compatibility();
