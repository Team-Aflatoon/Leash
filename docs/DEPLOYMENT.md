# Deploying Leash for free

This guide puts a public Leash demo online. **Every service is on a free plan. No card is needed.**

| Piece | Service | Plan | Cost |
|-------|---------|------|------|
| Web app (gateway, worker, owner console, agent) | [Render](https://render.com) web service, Docker | Free | $0 |
| Database | [Neon](https://neon.com) Postgres | Free | $0 |
| Payments | [PayPal Developer](https://developer.paypal.com) sandbox | Free | $0, no real money moves |
| LLM | [Google AI Studio](https://aistudio.google.com) Gemini API key | Free tier | $0 |
| Code | GitHub repo `Team-Aflatoon/Leash` | Free | $0 |

Time needed: about 30 minutes for a first deploy.

## Why these choices

- **Render free web service.** It builds our `Dockerfile` straight from GitHub and gives an HTTPS URL. The catch:
  it **sleeps after 15 minutes without traffic**, and the next visit takes **about a minute** to wake it.
  ([Render docs](https://render.com/docs/free))
- **Neon instead of Render's own Postgres.** Render's free Postgres **expires 30 days after creation**, and then the
  data is gone unless you pay. That is shorter than a hackathon judging window. Neon's free plan does not expire.
  It gives 1 GB storage and 100 compute-hours a month per project, and the database pauses itself after 5 minutes
  idle. ([Render docs](https://render.com/docs/free), [Neon free plan FAQ](https://neon.com/faqs/free-plan-limits-and-quotas))
- **Not used:** Railway, Fly.io and Heroku have no lasting free plan for new accounts.

## Before you start

You need:

1. A GitHub account with access to `Team-Aflatoon/Leash`.
2. A **PayPal sandbox app** (Client ID and Secret) and a **sandbox Personal (buyer) account**. Both are under
   developer.paypal.com → Apps & Credentials and → Sandbox → Accounts. Use a US app; it is the one tested.
3. A **Gemini API key** from aistudio.google.com → Get API key.

Never paste these keys into the repo, an issue, or a chat. They go only into the Render dashboard.

## Step 1: Create the database (Neon)

1. Sign up at neon.com (GitHub login works). Choose the **Free** plan.
2. Create a project, for example `leash`, in the region closest to your Render region (for Render Oregon, pick
   AWS US West 2; for Render Frankfurt, pick AWS Europe Central 1).
3. Open **Connect**. Turn **Connection pooling OFF** so you get the **direct** connection string.
   Leash uses row locks and transactions that need a direct connection.
4. Copy the string. It looks like
   `postgresql://user:password@ep-xxxx.us-west-2.aws.neon.tech/neondb?sslmode=require`.
   This is your `DATABASE_URL`.

You do not need to create tables. Leash runs its migrations every time it starts.

## Step 2: Create the web service (Render)

1. Sign up at render.com with GitHub. No card is needed for free services.
2. Choose **New → Blueprint**, pick the `Team-Aflatoon/Leash` repo and the `main` branch. Render reads
   `render.yaml`, which describes one **free** Docker web service called `leash`.
3. Render asks for the values marked secret. Fill them in:

| Variable | What to put |
|----------|-------------|
| `DATABASE_URL` | The Neon direct connection string from Step 1 |
| `PUBLIC_URL` | Leave as `https://leash.onrender.com` for now. Fix it in Step 3 once you know the real URL. |
| `PAYPAL_CLIENT_ID` | Sandbox app Client ID |
| `PAYPAL_CLIENT_SECRET` | Sandbox app Secret |
| `GEMINI_API_KEY` | Your Gemini key |
| `PAYPAL_WEBHOOK_ID` | Leave empty for now (Step 4) |
| `AGENT_GEMINI_API_KEY` | Optional: a second Gemini key just for the live agent. Empty means it uses `GEMINI_API_KEY`. |
| `ANTHROPIC_API_KEY`, `AGENT_ANTHROPIC_API_KEY` | Leave empty. Only needed with `LLM_PROVIDER=anthropic`, which is paid. |

   These are set for you by the Blueprint: `GATEWAY_SIGNING_KEY` and `AGENT_TOKEN` (random), `LLM_PROVIDER=gemini`,
   `GEMINI_MODEL`, `DEMO_MODE=true`, `TRUST_PROXY_HOPS=1`, `MAX_AGENT_RUNS=3`, `APPROVAL_TIMEOUT_SECONDS=600`.
   Do not change `GATEWAY_SIGNING_KEY` later: the signed ledger checkpoints depend on it.

4. Click **Apply**. The first build takes 5 to 10 minutes. It is done when the service shows **Live** and
   `https://<your-service>.onrender.com/api/health` returns `{"ok":true}`.

## Step 3: Set the public URL

1. Copy the service URL from the top of the Render page, for example `https://leash-ab12.onrender.com`.
2. Go to **Environment**, set `PUBLIC_URL` to that exact URL with no trailing slash, and save. Render redeploys.

PayPal sends the buyer back to this URL after they approve, so it must be right.

## Step 4: Register the PayPal webhook

Run this once from your own computer, in the repo folder, after `pnpm install`:

```bash
PUBLIC_URL=https://<your-service>.onrender.com \
PAYPAL_CLIENT_ID=<sandbox client id> \
PAYPAL_CLIENT_SECRET=<sandbox secret> \
pnpm --filter @leash/gateway register-webhook
```

It prints `PAYPAL_WEBHOOK_ID=...`. Put that value into Render → Environment → `PAYPAL_WEBHOOK_ID` and save.

You can also do it by hand: developer.paypal.com → your app → **Add Webhook**, URL
`https://<your-service>.onrender.com/api/paypal/webhook`, with the events listed in
`apps/gateway/scripts/register-webhook.ts`. Then copy the webhook ID into Render.

## Step 5: Check it works

1. Open the URL. The first load after sleeping takes about a minute.
2. **Create owner key**, then **Mandate → Link PayPal sandbox account**, and log in as the sandbox buyer.
   The sandbox app may not have Vault enabled; Leash then falls back to a one-time PayPal approval, which is expected.
3. **Red team → Run red team.** All six scenarios should finish. The honest order is captured in PayPal, the
   duplicate is held for you, and the attacks are blocked.
4. **Ledger** should report the chain as intact (use **Verify again** to re-check).
5. Optional: `npx tsx scripts/smoke.ts https://<your-service>.onrender.com` drives the API end to end.

## Living with the free plans

- **Wake it before you demo.** Open the URL a minute or two before a judge or a recording session. While someone is
  using it, it stays awake.
- **Do not add a 24/7 uptime pinger.** It would keep Neon's database awake all month. At Neon's smallest size that
  is about 180 compute-hours, more than the 100 free hours, and Neon would pause the database until the next month.
  If you want it awake during judging, ping `/api/health` every 10 minutes only during those days (cron-job.org is free).
- **Timers run late while asleep.** A held payment auto-voids after 10 minutes, but if the service is asleep the void
  runs when it wakes. Money jobs are stored in the database, so none are lost.
- **PayPal webhooks still arrive.** PayPal retries failed deliveries, and the first retry wakes the service.
- **Gemini free tier is rate limited.** At busy times the model can answer "high demand". Leash retries, falls back to
  a smaller model, and if all fail it **holds** the order rather than allowing it. The red team does not need the LLM.
- **Free instance size** is 512 MB RAM. That is enough for the gateway plus one live agent run at a time.

## Updating

Push to `main`. Render rebuilds and redeploys automatically. Migrations run on start, so schema changes apply
themselves.

## If something goes wrong

| Symptom | Fix |
|---------|-----|
| Build fails on Render | Open **Logs** for the build. Check that `main` builds locally with `docker build .`. |
| Logs say `missing env DATABASE_URL` | Set `DATABASE_URL` in Render → Environment. |
| Database connection error mentioning `channel_binding` | Remove `&channel_binding=require` from the end of the Neon string. |
| Database connection times out | Make sure you used the **direct** string (pooling off), not the `-pooler` host. |
| Linking PayPal returns to a localhost page | `PUBLIC_URL` is still wrong. Redo Step 3. |
| Payments are all refused with "not configured" | `PAYPAL_CLIENT_ID` or `PAYPAL_CLIENT_SECRET` is missing or wrong. |
| Intent check says "not configured" | `GEMINI_API_KEY` is missing. Rules still decide everything. |
| Neon says compute quota reached | Something kept the database awake all month. Remove any pinger; it resets next month. |

## Before the repo goes public

Rotate the PayPal sandbox secret and the Gemini key that were shared during development, then update them in Render.
