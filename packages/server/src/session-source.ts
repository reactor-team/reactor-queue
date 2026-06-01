/**
 * Where the queue gets a Reactor `session_id` to hand an admitted user.
 *
 * By default the queue *creates* a session on claim (`POST /sessions`) and
 * *stops* it on teardown (`DELETE /sessions/{id}`). A {@link SessionSource} lets
 * you swap that for a **pre-provisioned pool**: sessions that already exist —
 * typically with a backend agent ("robot") connected via the Python SDK — that
 * the queue *leases* to the next admitted human and *releases* when they leave.
 *
 * The human still attaches with `connect({ sessionId })` and the queue still
 * mints the JWT, so the leased session **must belong to the same Reactor account
 * as the queue's API key** (otherwise the minted JWT can't attach to it).
 */
export interface SessionSource {
  /**
   * Return the id of a ready-to-use Reactor session (e.g. one that already has a
   * robot connected). Called once per slot, on the first member's `claim()`.
   * Throw to signal "none available" — the queue surfaces an `error` to the
   * client, who can retry.
   */
  acquire(ctx: { model: string }): Promise<string>;
  /**
   * The queue is done with a leased session (member left, timed out, or it was
   * force-closed). Return it to the pool / recycle it however you like. Should
   * be idempotent; the queue may call it for a session that already ended.
   */
  release(sessionId: string, reason: string): Promise<void>;
}

/**
 * Built-in {@link SessionSource} that leases from an HTTP pool service.
 * Configured via `RQ_SESSION_POOL_URL` (+ optional `RQ_SESSION_POOL_TOKEN`).
 *
 * Wire contract (your pool service implements these):
 *   - `POST {url}/lease`   body `{ model }`  → 2xx `{ "session_id": "..." }`
 *                                              non-2xx ⇒ "pool empty", queue retries
 *   - `POST {url}/release` body `{ session_id, reason }` → 2xx
 *
 * When `token` is set it is sent as `Authorization: Bearer <token>`.
 */
export class HttpSessionPool implements SessionSource {
  private readonly url: string;
  private readonly token: string | null;

  constructor(opts: { url: string; token?: string | null }) {
    this.url = opts.url.replace(/\/+$/, "");
    this.token = opts.token ?? null;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async acquire(ctx: { model: string }): Promise<string> {
    const res = await fetch(`${this.url}/lease`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model: ctx.model }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`session pool lease failed: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { session_id?: string; sessionId?: string };
    const sessionId = data.session_id ?? data.sessionId;
    if (!sessionId) throw new Error("session pool lease: no session_id in response");
    return sessionId;
  }

  async release(sessionId: string, reason: string): Promise<void> {
    const res = await fetch(`${this.url}/release`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ session_id: sessionId, reason }),
    });
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`session pool release failed: ${res.status} ${detail}`);
    }
  }
}
