#!/usr/bin/env bash
# Proves the security tests have teeth: each mutation removes one guard; the named test MUST fail.
# Requires a clean working tree for the mutated files (each is restored with `git checkout` afterwards).
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0; fail=0
mutate() {
  local name="$1" file="$2" from="$3" to="$4" test="$5"
  if ! grep -qF -- "$from" "$file"; then echo "?? $name: pattern not found in $file"; fail=$((fail+1)); return; fi
  node -e 'const fs=require("fs");const [f,a,b]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").split(a).join(b))' "$file" "$from" "$to"
  if npx vitest run -t "$test" >/tmp/leash-mut.log 2>&1; then
    echo "SURVIVED  $name  (test '$test' still passes — guard is untested!)"; fail=$((fail+1))
  elif grep -qE "SyntaxError|Transform failed|ERR_MODULE" /tmp/leash-mut.log; then
    echo "ERRORED   $name  (mutant did not compile; not a valid kill)"; fail=$((fail+1))
  else
    echo "killed    $name"; pass=$((pass+1))
  fi
  git checkout -- "$file"
}

mutate "G5 mandate row lock removed"        apps/gateway/src/service.ts 'WHERE mandate_id = $1 FOR NO KEY UPDATE", [p.mandate_id]' 'WHERE mandate_id = $1", [p.mandate_id]' "never exceed"
mutate "G5 idempotency unique index removed" apps/gateway/migrations/001_init.sql 'CREATE UNIQUE INDEX decisions_idem' 'CREATE INDEX decisions_idem' "20 concurrent copies"
mutate "G2 address lock disabled"           packages/core/src/policy.ts 'if (proposal.ship_to && !sameAddress' 'if (false && proposal.ship_to && !sameAddress' "redirected shipping address"
mutate "G2 price claim ignored"             packages/core/src/policy.ts 'pl.claimed_unit_price_cents !== item.unit_price_cents)' 'false)' "lowballed price"
mutate "G3 LLM may loosen"                  packages/core/src/policy.ts 'reasons.reduce<Outcome>((o, r) => stricter(o, r.outcome), rules.outcome)' '(verdict.kind === "consistent" ? "ALLOW" : reasons.reduce<Outcome>((o, r) => stricter(o, r.outcome), rules.outcome))' "never looser"
mutate "G4 signature not re-verified"       apps/gateway/src/service.ts 'canonicalHash(row.body) === row.body_hash && verifyJson(' 'true || (' "edited in the database"
mutate "G4 revocation ignored at capture"   apps/gateway/src/service.ts 'if (m.revoked_at) return "mandate revoked";' '' "while PayPal is authorizing"
mutate "G1 agent env not filtered"          apps/gateway/src/redteam.ts 'for (const k of keep) if (base[k]) env[k] = base[k]!;' 'Object.assign(env, base);' "allowlist without secrets"
mutate "G1 approval signature not checked"  apps/gateway/src/service.ts 'if (!owner || !verifyJson("approval"' 'if (false && !verifyJson("approval"' "cannot approve its own"
mutate "G7 ledger trigger removed"          apps/gateway/migrations/001_init.sql 'CREATE TRIGGER ledger_no_update' '-- CREATE TRIGGER ledger_no_update' "refuses UPDATE"
mutate "Webhook verification bypassed"      apps/gateway/src/service.ts 'if (!verified) throw new HttpError(400, "webhook signature not verified");' '' "never change state"
mutate "R1 agent token scope ignored"        apps/gateway/src/service.ts 'const outOfScope = scopeMandateId !== null && scopeMandateId !== p.mandate_id;' 'const outOfScope = false;' "cannot spend against mandate B"
mutate "R2 dashboard owner check removed"   apps/gateway/src/app.ts 'if (a.owner_id !== (req.params as { id: string }).id) throw new HttpError(403, "not your dashboard");' '' "dashboard requires"
mutate "R3 already-captured read as void"   apps/gateway/src/service.ts 'if (res.status === "ALREADY_CAPTURED") {' 'if (false) {' "records a capture"
mutate "R6 unverified webhooks stored"      apps/gateway/src/service.ts 'if (!verified) throw new HttpError(400, "webhook signature not verified");' 'if (!verified) { await deps.db.query("INSERT INTO webhook_events(event_id, event_type, verified, payload) VALUES ($1,$2,false,$3) ON CONFLICT DO NOTHING", [event.id, event.event_type, rawBody]); throw new HttpError(400, "webhook signature not verified"); }' "shadow genuine"
mutate "R9 approval expiry unchecked"       apps/gateway/src/service.ts 'if (approved && p.approval_expires_at &&' 'if (false && p.approval_expires_at &&' "expired holds"
mutate "Plan B hold limit ignored"          packages/core/src/policy.ts 'total > input.fundingRemainingCents)' 'false)' "overdraw one hold"
mutate "Plan B in-doubt capture released"    apps/gateway/src/service.ts 'if (dead && !(p.funding === "hold" && p.capture_sent_at)) {' 'if (dead) {' "answer was lost"

echo; echo "killed $pass, survived/errored $fail"
[ "$fail" -eq 0 ]
