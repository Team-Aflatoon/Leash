-- Fixes from the adversarial review (docs/REVIEW.md).

-- R1: agent tokens are minted per run and scoped to exactly one mandate, with an expiry.
CREATE TABLE agent_tokens (
  token_sha256 text PRIMARY KEY,
  agent_id     text NOT NULL,
  mandate_id   uuid NOT NULL REFERENCES mandates(mandate_id),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- R5: signed checkpoints are as append-only as the ledger itself.
CREATE TRIGGER ledger_checkpoints_no_update BEFORE UPDATE OR DELETE ON ledger_checkpoints FOR EACH ROW EXECUTE FUNCTION leash_ledger_immutable();
CREATE TRIGGER ledger_checkpoints_no_truncate BEFORE TRUNCATE ON ledger_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION leash_ledger_immutable();
