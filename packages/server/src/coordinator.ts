import { TERMINAL_SESSION_STATES } from "@reactor-team/queue-protocol";

/**
 * Thin server-side client for the Reactor Coordinator REST API. It does exactly
 * three things, all from inside the trusted PartyKit server:
 *
 *  1. mint short-lived client JWTs from the API key (`POST /tokens`),
 *  2. read a session's state (`GET /sessions/{id}/runtime`), and
 *  3. stop a session (`DELETE /sessions/{id}`).
 *
 * (2) and (3) need a Bearer JWT, so the client keeps its own cached "server
 * JWT" (minted with a longer TTL) and reuses it across calls.
 */
export class CoordinatorClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVersion: number;

  private serverJwt: { jwt: string; expiresAt: number } | null = null;
  /** TTL for the server's own admin JWT. Longer than client tokens; re-minted lazily. */
  private static readonly SERVER_JWT_TTL_SECONDS = 600;
  private static readonly SKEW_SECONDS = 30;

  constructor(opts: { baseUrl: string; apiKey: string; apiVersion: number }) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
  }

  private versionHeaders(): Record<string, string> {
    return {
      "Reactor-API-Version": String(this.apiVersion),
      "Reactor-API-Accept-Version": String(this.apiVersion),
    };
  }

  /**
   * Exchange the API key for a JWT. `ttlSeconds` is passed as `expires_after`;
   * the Coordinator caps it at its server maximum.
   */
  async mintToken(ttlSeconds: number): Promise<{ jwt: string; expiresAt: number }> {
    const res = await fetch(`${this.baseUrl}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Reactor-API-Key": this.apiKey,
        ...this.versionHeaders(),
      },
      body: JSON.stringify({ expires_after: Math.max(1, Math.floor(ttlSeconds)) }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`mintToken failed: ${res.status} ${detail}`);
    }

    const data = (await res.json()) as { jwt?: string; token?: string; expires_at?: number };
    const jwt = data.jwt ?? data.token;
    if (!jwt) throw new Error("mintToken: no jwt in response");
    const expiresAt = data.expires_at ?? Math.floor(Date.now() / 1000) + ttlSeconds;
    return { jwt, expiresAt };
  }

  private async getServerJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.serverJwt && this.serverJwt.expiresAt - now > CoordinatorClient.SKEW_SECONDS) {
      return this.serverJwt.jwt;
    }
    this.serverJwt = await this.mintToken(CoordinatorClient.SERVER_JWT_TTL_SECONDS);
    return this.serverJwt.jwt;
  }

  /**
   * Returns the session's current state string, `"CLOSED"` if the session is
   * gone (404), or `null` if the lookup itself failed (so callers can avoid
   * freeing a slot on a transient network error).
   */
  async getSessionState(sessionId: string): Promise<string | null> {
    let jwt: string;
    try {
      jwt = await this.getServerJwt();
    } catch {
      return null;
    }

    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/runtime`, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}`, ...this.versionHeaders() },
    });

    if (res.status === 404) return "CLOSED";
    if (!res.ok) return null;

    const data = (await res.json().catch(() => null)) as { state?: string } | null;
    return data?.state ?? null;
  }

  /** True if a state string means the slot should be released. */
  static isTerminal(state: string | null): boolean {
    return state !== null && (TERMINAL_SESSION_STATES as readonly string[]).includes(state);
  }

  /** Force-close a session. Swallows "already gone" responses. */
  async stopSession(sessionId: string, reason = "queue: session time elapsed"): Promise<void> {
    const jwt = await this.getServerJwt();
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        ...this.versionHeaders(),
      },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`stopSession failed: ${res.status} ${detail}`);
    }
  }
}
