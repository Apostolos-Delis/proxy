CREATE TABLE IF NOT EXISTS routing_configs (
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

CREATE UNIQUE INDEX IF NOT EXISTS routing_configs_org_id_idx ON routing_configs (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS routing_configs_org_slug_idx ON routing_configs (organization_id, slug);
CREATE INDEX IF NOT EXISTS routing_configs_organization_id_idx ON routing_configs (organization_id);
CREATE INDEX IF NOT EXISTS routing_configs_active_version_idx ON routing_configs (organization_id, active_version_id);

CREATE TABLE IF NOT EXISTS routing_config_versions (
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
  archived_at timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS routing_config_versions_config_version_idx ON routing_config_versions (organization_id, routing_config_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS routing_config_versions_config_id_idx ON routing_config_versions (organization_id, routing_config_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS routing_config_versions_org_hash_idx ON routing_config_versions (organization_id, config_hash);
CREATE INDEX IF NOT EXISTS routing_config_versions_config_idx ON routing_config_versions (organization_id, routing_config_id);

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS routing_config_id text;

CREATE INDEX IF NOT EXISTS api_keys_routing_config_idx ON api_keys (organization_id, routing_config_id);

ALTER TABLE organization_settings
  ADD COLUMN IF NOT EXISTS default_routing_config_id text;

ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS routing_config_id text,
  ADD COLUMN IF NOT EXISTS routing_config_version_id text,
  ADD COLUMN IF NOT EXISTS routing_config_version integer,
  ADD COLUMN IF NOT EXISTS routing_config_hash text;

CREATE INDEX IF NOT EXISTS requests_routing_config_idx ON requests (organization_id, routing_config_id);

ALTER TABLE route_decisions
  ADD COLUMN IF NOT EXISTS routing_config_id text,
  ADD COLUMN IF NOT EXISTS routing_config_version_id text,
  ADD COLUMN IF NOT EXISTS routing_config_version integer,
  ADD COLUMN IF NOT EXISTS routing_config_hash text;

CREATE INDEX IF NOT EXISTS route_decisions_routing_config_idx ON route_decisions (organization_id, routing_config_id);

CREATE TABLE IF NOT EXISTS provider_accounts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  name text NOT NULL,
  secret_ref text,
  status text NOT NULL DEFAULT 'active',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_org_provider_name_idx ON provider_accounts (organization_id, provider, name);
CREATE INDEX IF NOT EXISTS provider_accounts_organization_id_idx ON provider_accounts (organization_id);

CREATE TABLE IF NOT EXISTS model_catalog (
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

CREATE UNIQUE INDEX IF NOT EXISTS model_catalog_org_provider_model_idx ON model_catalog (organization_id, provider, model);
CREATE INDEX IF NOT EXISTS model_catalog_route_idx ON model_catalog (organization_id, route);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routing_config_versions_config_fk'
  ) THEN
    ALTER TABLE routing_config_versions
      ADD CONSTRAINT routing_config_versions_config_fk FOREIGN KEY (organization_id, routing_config_id)
      REFERENCES routing_configs(organization_id, id) ON DELETE CASCADE NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routing_configs_active_version_fk'
  ) THEN
    ALTER TABLE routing_configs
      ADD CONSTRAINT routing_configs_active_version_fk FOREIGN KEY (organization_id, id, active_version_id)
      REFERENCES routing_config_versions(organization_id, routing_config_id, id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_routing_config_fk'
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_routing_config_fk FOREIGN KEY (organization_id, routing_config_id)
      REFERENCES routing_configs(organization_id, id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_settings_default_routing_config_fk'
  ) THEN
    ALTER TABLE organization_settings
      ADD CONSTRAINT organization_settings_default_routing_config_fk FOREIGN KEY (organization_id, default_routing_config_id)
      REFERENCES routing_configs(organization_id, id) NOT VALID;
  END IF;
END $$;
