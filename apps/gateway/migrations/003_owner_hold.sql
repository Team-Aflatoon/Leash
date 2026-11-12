-- Plan B consent (DECISIONS D13/D14): when PayPal won't vault, the owner approves ONE standing authorization ("the
-- hold") once; every purchase is a partial capture from it with no redirect. The mandate rules still decide.
ALTER TABLE owners
  ADD COLUMN paypal_hold_order_id   text,
  ADD COLUMN paypal_hold_auth_id    text,
  ADD COLUMN paypal_hold_cents      bigint,
  ADD COLUMN paypal_hold_status     text NOT NULL DEFAULT 'NONE' CHECK (paypal_hold_status IN ('NONE','AWAITING_BUYER','AUTHORIZED','VOIDED','EXPIRED')),
  ADD COLUMN paypal_hold_expires_at timestamptz;

-- How a payment is funded: from the vaulted wallet (its own order and authorization) or from the owner's hold.
ALTER TABLE payments
  ADD COLUMN funding text NOT NULL DEFAULT 'vault' CHECK (funding IN ('vault','hold')),
  ADD COLUMN funding_ref text,  -- the hold authorization id this payment draws from
  ADD COLUMN capture_sent_at timestamptz;  -- set (and committed) before a capture request leaves; never released after
CREATE INDEX payments_funding_ref ON payments(funding_ref) WHERE funding_ref IS NOT NULL;
