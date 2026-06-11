-- Pin the resolved provider settings (model/effort/thinking/verbosity) and the
-- routing-config version that produced them on the session, so route-kept
-- requests can reuse the exact upstream request shape and keep provider
-- prompt caches warm across proxy restarts and replicas.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS pinned_settings jsonb,
  ADD COLUMN IF NOT EXISTS routing_config_version_id text;
