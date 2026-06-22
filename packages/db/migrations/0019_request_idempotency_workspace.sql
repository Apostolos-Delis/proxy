DROP INDEX IF EXISTS requests_org_idempotency_idx;
CREATE UNIQUE INDEX requests_org_workspace_idempotency_idx
  ON requests (organization_id, workspace_id, idempotency_key);
