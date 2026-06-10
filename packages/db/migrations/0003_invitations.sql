CREATE TABLE IF NOT EXISTS invitations (
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

CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_idx ON invitations (token_hash);
CREATE INDEX IF NOT EXISTS invitations_org_email_idx ON invitations (organization_id, email);
CREATE INDEX IF NOT EXISTS invitations_org_status_idx ON invitations (organization_id, status);
