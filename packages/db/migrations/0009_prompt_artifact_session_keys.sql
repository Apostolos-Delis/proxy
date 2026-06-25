ALTER TABLE prompt_artifacts ADD COLUMN session_id text;

UPDATE prompt_artifacts artifact
SET session_id = request.session_id
FROM requests request
WHERE artifact.organization_id = request.organization_id
  AND artifact.request_id = request.id;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY organization_id, workspace_id, session_id, kind, content_hash
      ORDER BY created_at, id
    ) AS row_number
  FROM prompt_artifacts
  WHERE session_id IS NOT NULL
)
DELETE FROM prompt_artifacts
WHERE id IN (
  SELECT id
  FROM ranked
  WHERE row_number > 1
);

ALTER TABLE prompt_artifacts
  ADD CONSTRAINT prompt_artifacts_session_fk
  FOREIGN KEY (session_id)
  REFERENCES agent_sessions(id)
  ON DELETE SET NULL;

CREATE UNIQUE INDEX prompt_artifacts_session_kind_hash_idx
  ON prompt_artifacts (organization_id, workspace_id, session_id, kind, content_hash)
  WHERE session_id IS NOT NULL;

CREATE INDEX prompt_artifacts_org_workspace_session_idx
  ON prompt_artifacts (organization_id, workspace_id, session_id, created_at);
