CREATE TABLE IF NOT EXISTS providers (
  id uuid PRIMARY KEY,
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  display_name text NOT NULL,
  base_url text NOT NULL,
  auth_style text NOT NULL CHECK (auth_style IN ('bearer', 'x-api-key', 'none')),
  endpoints jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  forward_harness_headers boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS providers_org_slug_idx
  ON providers (organization_id, slug) NULLS NOT DISTINCT;
