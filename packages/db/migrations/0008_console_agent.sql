CREATE TABLE IF NOT EXISTS console_agent_conversations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  title text,
  session_state jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS console_agent_conversations_org_id_idx
  ON console_agent_conversations (organization_id, id);
CREATE INDEX IF NOT EXISTS console_agent_conversations_org_created_idx
  ON console_agent_conversations (organization_id, created_at);
CREATE INDEX IF NOT EXISTS console_agent_conversations_org_creator_idx
  ON console_agent_conversations (organization_id, created_by_user_id);

CREATE TABLE IF NOT EXISTS console_agent_runs (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  model text,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  CONSTRAINT console_agent_runs_conversation_fk
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES console_agent_conversations (organization_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS console_agent_runs_org_id_idx
  ON console_agent_runs (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS console_agent_runs_active_idx
  ON console_agent_runs (organization_id, conversation_id)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS console_agent_runs_conversation_idx
  ON console_agent_runs (organization_id, conversation_id);
CREATE INDEX IF NOT EXISTS console_agent_runs_org_status_idx
  ON console_agent_runs (organization_id, status);

CREATE TABLE IF NOT EXISTS console_agent_messages (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  role text NOT NULL,
  content jsonb NOT NULL,
  page_scope jsonb,
  run_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT console_agent_messages_conversation_fk
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES console_agent_conversations (organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT console_agent_messages_run_fk
    FOREIGN KEY (organization_id, run_id)
    REFERENCES console_agent_runs (organization_id, id)
);

CREATE INDEX IF NOT EXISTS console_agent_messages_conversation_created_idx
  ON console_agent_messages (organization_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS console_agent_messages_org_run_idx
  ON console_agent_messages (organization_id, run_id);

CREATE TABLE IF NOT EXISTS console_agent_run_events (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT console_agent_run_events_run_fk
    FOREIGN KEY (organization_id, run_id)
    REFERENCES console_agent_runs (organization_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS console_agent_run_events_org_run_seq_idx
  ON console_agent_run_events (organization_id, run_id, seq);

CREATE TABLE IF NOT EXISTS console_agent_proposals (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  conversation_id text NOT NULL,
  run_id text NOT NULL,
  capability_key text NOT NULL,
  input jsonb NOT NULL,
  preview jsonb NOT NULL DEFAULT '{}'::jsonb,
  base_state jsonb,
  dedupe_key text,
  status text NOT NULL DEFAULT 'pending',
  proposed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  resolved_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT console_agent_proposals_conversation_fk
    FOREIGN KEY (organization_id, conversation_id)
    REFERENCES console_agent_conversations (organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT console_agent_proposals_run_fk
    FOREIGN KEY (organization_id, run_id)
    REFERENCES console_agent_runs (organization_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS console_agent_proposals_dedupe_idx
  ON console_agent_proposals (organization_id, dedupe_key)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS console_agent_proposals_org_status_idx
  ON console_agent_proposals (organization_id, status);
CREATE INDEX IF NOT EXISTS console_agent_proposals_conversation_idx
  ON console_agent_proposals (organization_id, conversation_id);
CREATE INDEX IF NOT EXISTS console_agent_proposals_org_run_idx
  ON console_agent_proposals (organization_id, run_id);
