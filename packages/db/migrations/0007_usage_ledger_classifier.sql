ALTER TABLE usage_ledger
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'provider';

ALTER TABLE usage_ledger
  ALTER COLUMN provider_attempt_id DROP NOT NULL;

-- Classifier rows have no provider attempt, so the per-attempt unique index no
-- longer covers them. Idempotency for classifier rows is enforced per request
-- via their deterministic id (usage_classifier:<requestId>) on the primary key.
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_classifier_request_idx
  ON usage_ledger (request_id)
  WHERE kind = 'classifier';
