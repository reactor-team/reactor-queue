import { TERMINAL_SESSION_STATES } from "../protocol";

/**
 * Raised when the Coordinator answers a request with a non-OK status. Carries
 * the `endpoint`, HTTP `status`, and raw response `body` so callers (and the
 * admin log) can show *why* a call failed — a quota rejection, an expired key,
 * a bad model — instead of a generic "session create failed".
 */
export class CoordinatorError extends Error {
  readonly endpoint: string;
  readonly status: number;
  readonly body: string;

  constructor(endpoint: string, status: number, body: string) {
    super(`${endpoint} failed: ${status} ${body || "(no body)"}`);
    this.name = "CoordinatorError";
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

/**
 * Session authorization scope for a minted JWT. When passed to
 * {@link CoordinatorClient.mintToken}, the JWT is restricted to the named model
 * and to the sessions its grant holds — nothing else on the account.
 */
export interface TokenScope {
  /** Model the token is confined to (fully-qualified `org/model`). */
  model: string;
  /**
   * Existing sessions the grant starts bound to. Each must still be open and
   * owned by the API key doing the minting; the Coordinator answers `403`
   * otherwise, and refuses a session whose model falls outside `model`.
   */
  sessions?: string[];
  /**
   * How many sessions the grant may hold over its lifetime. Left unset it
   * resolves to the number of bound sessions, which leaves the token full on
   * arrival: it operates what it was given and cannot create more.
   */
  maxSessions?: number;
}

/**
 * Thin server-side client for the Reactor Coordinator REST API. From inside the
 * trusted PartyKit server it:
 *
 *  1. mints short-lived client JWTs from the API key (`POST /tokens`),
 *     optionally scoped to one model via `authorization_details`,
 *  2. creates sessions (`POST /sessions`),
 *  3. reads a session's state (`GET /sessions/{id}/runtime`), and
 *  4. stops a session (`DELETE /sessions/{id}`).
 *
 * (2)–(4) need a Bearer JWT. By default the client keeps its own cached
 * "server JWT" (unscoped, minted with a longer TTL) and reuses it across
 * calls; `createSession`/`createConnection` also accept an explicit `jwt` so
 * a session can be created *by* a scoped token, binding it to that token's
 * grant.
 */
export class CoordinatorClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiVersion: number;
  private readonly webrtcVersion: string;

  private serverJwt: { jwt: string; expiresAt: number } | null = null;
  /** TTL for the server's own admin JWT. Longer than client tokens; re-minted lazily. */
  private static readonly SERVER_JWT_TTL_SECONDS = 600;
  private static readonly SKEW_SECONDS = 30;

  constructor(opts: {
    baseUrl: string;
    apiKey: string;
    apiVersion: number;
    webrtcVersion: string;
  }) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.webrtcVersion = opts.webrtcVersion;
  }

  private versionHeaders(): Record<string, string> {
    return {
      "Reactor-API-Version": String(this.apiVersion),
      "Reactor-API-Accept-Version": String(this.apiVersion),
    };
  }

  /**
   * Exchange the API key for a JWT. `ttlSeconds` is passed as `expires_after`;
   * the Coordinator caps it at its server maximum. With a `scope`, the JWT
   * carries session `authorization_details`: it is confined to `scope.model`
   * and to the sessions on its grant, which `scope.sessions` can pre-populate
   * with sessions that already exist. The bound set is server state rather than
   * a claim, so it never appears in the token itself.
   */
  async mintToken(
    ttlSeconds: number,
    scope?: TokenScope
  ): Promise<{ jwt: string; expiresAt: number }> {
    const res = await fetch(`${this.baseUrl}/tokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Reactor-API-Key": this.apiKey,
        ...this.versionHeaders(),
      },
      body: JSON.stringify({
        expires_after: Math.max(1, Math.floor(ttlSeconds)),
        ...(scope
          ? {
              authorization_details: [
                {
                  type: "session",
                  resources: {
                    models: { match: [scope.model] },
                    ...(scope.sessions?.length ? { sessions: { bind: scope.sessions } } : {}),
                  },
                  ...(scope.maxSessions === undefined
                    ? {}
                    : { constraints: { max_sessions: scope.maxSessions } }),
                },
              ],
            }
          : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new CoordinatorError("POST /tokens", res.status, detail);
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

  /**
   * Create a Reactor session for the configured model. Returns the new
   * `session_id`. Runs billing/quota checks against the server's API key.
   */
  async createSession(opts: { model: string; webrtcVersion: string }): Promise<string> {
    const jwt = await this.getServerJwt();
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        ...this.versionHeaders(),
      },
      body: JSON.stringify({
        model: { name: opts.model },
        // Identifies the caller to the Coordinator for telemetry only; not the
        // package version. Left as a fixed marker for the queue server rather
        // than wired to package.json — bump by hand if the contract changes.
        client_info: {
          sdk_version: "0.1.0",
          sdk_type: "js",
        },
        supported_transports: [{ protocol: "webrtc", version: opts.webrtcVersion }],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new CoordinatorError("POST /sessions", res.status, detail);
    }

    const data = (await res.json()) as { session_id?: string };
    const sessionId = data.session_id;
    if (!sessionId) throw new Error("createSession: no session_id in response");
    return sessionId;
  }

  /**
   * Register a WebRTC connection under an existing session and return the
   * server-minted `connection_id`. This is a transport call, so it carries
   * `Reactor-WebRTC-Version` rather than the API-version headers.
   *
   * A {@link CoordinatorError} with `status === 429` means the session hit its
   * `connections_per_session` cap; the caller falls back to another/new session.
   */
  async createConnection(sessionId: string): Promise<number> {
    const jwt = await this.getServerJwt();
    const endpoint = `/sessions/${encodeURIComponent(sessionId)}/transport/webrtc/connections`;
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
        "Reactor-WebRTC-Version": this.webrtcVersion,
      },
      body: JSON.stringify({ client_info: { sdk_version: "0.1.0", sdk_type: "js" } }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new CoordinatorError(`POST ${endpoint}`, res.status, detail);
    }

    const data = (await res.json()) as { connection_id?: number };
    const connectionId = data.connection_id;
    if (typeof connectionId !== "number") {
      throw new Error("createConnection: no connection_id in response");
    }
    return connectionId;
  }

  /** Force-close a session. Swallows "already gone" responses. */
  async stopSession(sessionId: string, reason = "queue: session time elapsed"): Promise<void> {
    // The Bearer JWT the other calls use is minted as a session-type credential
    // (the coordinator stamps every /tokens mint with session
    // authorization_details, scoped or not), and a session-scoped JWT cannot
    // authorize a cross-resource DELETE on /sessions — it 403s, leaking the
    // session and its seat. Only the raw API key may force-close an arbitrary
    // session, so the DELETE carries it directly instead of the minted JWT.
    const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "Reactor-API-Key": this.apiKey,
        ...this.versionHeaders(),
      },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => res.statusText);
      throw new CoordinatorError(`DELETE /sessions/${sessionId}`, res.status, detail);
    }
  }
}
