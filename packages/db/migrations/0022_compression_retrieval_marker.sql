ALTER TABLE compression_receipts
  ADD COLUMN retrieval_available boolean NOT NULL DEFAULT false,
  ADD COLUMN retrieval_marker text;
