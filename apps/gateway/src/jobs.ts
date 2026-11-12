import { jobAuthorize, jobCapture, jobExpireApproval, jobProcessWebhook, jobVoid, type Deps } from "./service.ts";

interface JobRow {
  job_id: number;
  kind: string;
  payload: { payment_id?: string; reason?: string; event_id?: string };
  attempts: number;
}

const MAX_ATTEMPTS = 12;

async function claim(deps: Deps): Promise<JobRow | null> {
  const r = await deps.db.query<JobRow>(
    `UPDATE jobs SET locked_until = now() + interval '90 seconds', attempts = attempts + 1
     WHERE job_id = (
       SELECT job_id FROM jobs WHERE done_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now())
       ORDER BY run_at, job_id FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING job_id, kind, payload, attempts`,
  );
  return r.rows[0] ?? null;
}

async function runOne(deps: Deps, job: JobRow): Promise<void> {
  const pid = job.payload.payment_id ?? "";
  try {
    let retry = false;
    switch (job.kind) {
      case "payment.authorize":
        await jobAuthorize(deps, pid);
        break;
      case "payment.capture":
        await jobCapture(deps, pid);
        break;
      case "payment.void":
        retry = (await jobVoid(deps, pid, job.payload.reason ?? "")) === "retry";
        break;
      case "approval.expire":
        await jobExpireApproval(deps, pid);
        break;
      case "webhook.process":
        await jobProcessWebhook(deps, job.payload.event_id ?? "");
        break;
      default:
        throw new Error(`unknown job kind ${job.kind}`);
    }
    if (retry) await deps.db.query("UPDATE jobs SET locked_until = NULL, run_at = now() + interval '2 seconds' WHERE job_id = $1", [job.job_id]);
    else await deps.db.query("UPDATE jobs SET done_at = now(), last_error = NULL WHERE job_id = $1", [job.job_id]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Exponential backoff with the same idempotency keys on every retry. A payment stuck in RESERVED keeps its
    // budget reserved (fail-safe) until it resolves.
    const giveUp = job.attempts >= MAX_ATTEMPTS;
    await deps.db.query(
      "UPDATE jobs SET locked_until = NULL, last_error = $2, run_at = now() + make_interval(secs => $3), done_at = CASE WHEN $4 THEN now() ELSE NULL END WHERE job_id = $1",
      [job.job_id, msg.slice(0, 500), Math.min(2 ** job.attempts, 120), giveUp],
    );
  }
}

/** Process every due job until none are left. Used by tests and by the worker loop. */
export async function drainJobs(deps: Deps, maxJobs = 1000): Promise<number> {
  let n = 0;
  for (; n < maxJobs; n++) {
    const job = await claim(deps);
    if (!job) break;
    await runOne(deps, job);
  }
  return n;
}

export function startWorker(deps: Deps, intervalMs = 500) {
  let stopped = false;
  let running = false;
  let again = false;
  const tick = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await drainJobs(deps);
      } while (again && !stopped);
    } catch {
      /* logged via job rows */
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  return {
    wake: () => void tick(),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
