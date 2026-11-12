-- Leash schema. Money is integer cents. Times are timestamptz.

CREATE TABLE owners (
  owner_id        text PRIMARY KEY,
  display_name    text NOT NULL,
  public_key_hex  text NOT NULL CHECK (public_key_hex ~ '^[0-9a-f]{64}$'),
  paypal_vault_id text,
  paypal_setup_token text,
  paypal_payer_email text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  agent_id     text PRIMARY KEY,
  token_sha256 text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog (
  sku              text PRIMARY KEY,
  title            text NOT NULL,
  category         text NOT NULL,
  merchant_id      text NOT NULL,
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  currency         text NOT NULL,
  active           boolean NOT NULL DEFAULT true,
  description      text NOT NULL
);

CREATE TABLE mandates (
  mandate_id   uuid PRIMARY KEY,
  owner_id     text NOT NULL REFERENCES owners(owner_id),
  agent_id     text NOT NULL,
  body         jsonb NOT NULL,          -- exactly what the owner signed
  body_hash    text NOT NULL,           -- sha256 of canonical body
  signature    text NOT NULL,
  revoked_at   timestamptz,
  revocation_signature text,           -- owner's signed revocation, or NULL when the system retired it (demo reset)
  revocation_reason    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mandates_owner ON mandates(owner_id);

-- Every agent request lands here, including replays and conflicts.
CREATE TABLE decisions (
  decision_id     uuid PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('primary','replay','conflict','malformed')),
  replay_of       uuid REFERENCES decisions(decision_id),
  agent_id        text NOT NULL,
  idempotency_key text,
  mandate_id      uuid,
  request_body    jsonb NOT NULL,       -- what the agent sent (untrusted, for display/audit)
  request_hash    text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('ALLOW','HOLD','BLOCK')),
  reasons         jsonb NOT NULL,
  lines           jsonb NOT NULL,       -- gateway-resolved cart
  total_cents     bigint NOT NULL,
  cart_hash       text,
  intent_verdict  jsonb NOT NULL,
  mandate_hash    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- SAFETY (G5): one primary decision per (agent, idempotency key). Replays and conflicts are separate rows.
CREATE UNIQUE INDEX decisions_idem ON decisions(agent_id, idempotency_key) WHERE kind = 'primary';
CREATE INDEX decisions_dup ON decisions(mandate_id, cart_hash, created_at) WHERE kind = 'primary';

CREATE TABLE payments (
  payment_id       uuid PRIMARY KEY,
  decision_id      uuid NOT NULL UNIQUE REFERENCES decisions(decision_id),
  mandate_id       uuid NOT NULL REFERENCES mandates(mandate_id),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  currency         text NOT NULL,
  state            text NOT NULL CHECK (state IN ('RESERVED','AUTHORIZED','CAPTURED','VOIDED','FAILED')),
  needs_approval   boolean NOT NULL,
  approval         text NOT NULL CHECK (approval IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED','EXPIRED')),
  approval_expires_at timestamptz,
  approval_signature text,
  paypal_order_id         text,
  paypal_authorization_id text UNIQUE,
  paypal_capture_id       text UNIQUE,
  last_error       text,
  reconciliation   text NOT NULL DEFAULT 'PENDING' CHECK (reconciliation IN ('PENDING','CONFIRMED','MISMATCH')),
  reconciliation_note text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_mandate ON payments(mandate_id, state);

CREATE TABLE jobs (
  job_id       bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL,
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  done_at      timestamptz,
  last_error   text
);
CREATE INDEX jobs_due ON jobs(run_at) WHERE done_at IS NULL;

CREATE TABLE webhook_events (
  event_id     text PRIMARY KEY,
  event_type   text NOT NULL,
  resource_id  text,
  verified     boolean NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE llm_cache (
  cache_key  text PRIMARY KEY,
  model      text NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained audit ledger.
CREATE TABLE ledger (
  seq       bigint PRIMARY KEY,
  ts        text NOT NULL,
  type      text NOT NULL,
  data      jsonb NOT NULL,
  prev_hash text NOT NULL,
  hash      text NOT NULL UNIQUE
);
-- Single-row head pointer; locking it serialises appends so seq/prev_hash can't fork.
CREATE TABLE ledger_head (
  id   int PRIMARY KEY CHECK (id = 1),
  seq  bigint NOT NULL,
  hash text NOT NULL
);
INSERT INTO ledger_head VALUES (1, 0, repeat('0', 64));

CREATE TABLE ledger_checkpoints (
  seq        bigint PRIMARY KEY,
  hash       text NOT NULL,
  signed_at  text NOT NULL,
  signature  text NOT NULL
);

CREATE FUNCTION leash_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- No escape hatch: even demo reset never removes ledger entries.
  RAISE EXCEPTION 'ledger is append-only (% blocked)', TG_OP;
END $$;
CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION leash_ledger_immutable();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger FOR EACH STATEMENT EXECUTE FUNCTION leash_ledger_immutable();
