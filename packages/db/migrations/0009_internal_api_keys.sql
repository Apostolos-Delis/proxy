-- Internal traffic flag: console-agent calls are tagged on api_keys and
-- denormalized onto requests at receive time so analytics can exclude them
-- without joins.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS internal boolean NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS internal boolean NOT NULL DEFAULT false;
