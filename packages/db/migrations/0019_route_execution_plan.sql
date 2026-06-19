ALTER TABLE route_decisions
  ADD COLUMN route_execution_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN selected_candidate_id text,
  ADD COLUMN translated boolean NOT NULL DEFAULT false,
  ADD COLUMN translator_id text;

ALTER TABLE provider_attempts
  ADD COLUMN route_candidate_id text,
  ADD COLUMN attempt_index integer,
  ADD COLUMN fallback_index integer,
  ADD COLUMN skip_reason text;
