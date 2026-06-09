ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS routing_config_version integer;

ALTER TABLE route_decisions
  ADD COLUMN IF NOT EXISTS routing_config_version integer;
