ALTER TABLE compression_receipts
  ADD COLUMN retrieval_id text;

CREATE UNIQUE INDEX compression_receipts_retrieval_id_idx
  ON compression_receipts(retrieval_id)
  WHERE retrieval_id IS NOT NULL;

CREATE INDEX compression_receipts_org_workspace_retrieval_idx
  ON compression_receipts(organization_id, workspace_id, retrieval_id)
  WHERE retrieval_id IS NOT NULL;
