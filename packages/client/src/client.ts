import PartySocket from "partysocket";
import {
  CLIENT_ID_QUERY_KEY,
  DEFAULTS,
  DEFAULT_ROOM,
  parseServerMessage,
  type ClientMessage,
} from "@reactor-team/queue-protocol";
import {
  INITIAL_STATE,
  type QueueState,
  type ReactorQueueClientOptions,
} from "./types";

const CLIENT_ID_STORAGE_KEY = "reactor-queue:client-id";

function persistentClientId(): string {
  if (typeof localStorage === "undefined") {
    return cryptoRandomId();
  }
  let id = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (!id) {
    id = cryptoRandomId();
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
  }
  return id;
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type Listener = (state: QueueState) => void;

interface PendingTokenRequest {
  resolve: (jwt: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Framework-agnostic queue client. Manages one PartyKit WebSocket, tracks queue
 * state, and exposes a {@link ReactorQueueClient.getJwt} resolver that hands a
 * fresh short-lived Reactor JWT to the Reactor SDK on demand.
 *
 * It is intentionally decoupled from `@reactor-team/js-sdk`: you wire the two
 * together by passing `getJwt` to the SDK and `connectOptions.sessionId` from
 * {@link ReactorQueueClient.getState}'s `sessionId` (set on admission).
 */
export class ReactorQueueClient {
  private readonly opts: Required<
    Omit<ReactorQueueClientOptions, "clientId" | "party">
  > & { clientId: string; party?: string };

  private socket: PartySocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  private state: QueueState = { ...INITIAL_STATE };
  private listeners = new Set<Listener>();
  private pendingToken: PendingTokenRequest | null = null;

  constructor(options: ReactorQueueClientOptions) {
    this.opts = {
      host: options.host,
      room: options.room ?? DEFAULT_ROOM,
      party: options.party,
      clientId: options.clientId ?? persistentClientId(),
      autoConnect: options.autoConnect ?? false,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs,
      tokenSkewMs: options.tokenSkewMs ?? DEFAULTS.tokenSkewMs,
      tokenRequestTimeoutMs: options.tokenRequestTimeoutMs ?? 10_000,
      retryRejectedMs: options.retryRejectedMs ?? 3_000,
    };
    if (this.opts.autoConnect) this.connect();
  }

  // ── public state API ──────────────────────────────────────────────────────

  getState(): QueueState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<QueueState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  // ── connection control ──────────────────────────────────────────────────

  connect(): void {
    if (this.destroyed) return;
    this.teardownSocket();
    this.clearRetry();
    this.setState({
      ...INITIAL_STATE,
      phase: "connecting",
      // keep concurrency hints across reconnects so the UI doesn't flicker to 0
      capacity: this.state.capacity,
    });

    const socket = new PartySocket({
      host: this.opts.host,
      room: this.opts.room,
      party: this.opts.party,
      query: { [CLIENT_ID_QUERY_KEY]: this.opts.clientId },
    });
    this.socket = socket;

    this.heartbeat = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, this.opts.heartbeatIntervalMs);

    socket.addEventListener("message", (evt) => this.handleMessage(String(evt.data)));
    socket.addEventListener("close", () => this.handleClose());
  }

  /**
   * Leave the queue / release the slot and do not auto-rejoin. Returns to
   * `idle` — from the SDK's perspective leaving and never-having-joined are the
   * same state; the app decides whether to show a "rejoin?" prompt. The cached
   * token is intentionally kept so any in-flight SDK cleanup (e.g. its
   * `DELETE /sessions`) can still resolve a JWT during teardown.
   */
  leave(): void {
    this.send({ type: "leave" });
    this.clearRetry();
    this.clearRefresh();
    this.teardownSocket();
    this.setState({ phase: "idle" });
  }

  /** Re-enter the line (e.g. after expiry). */
  rejoin(): void {
    this.connect();
  }

  /** "I'm entering the demo now" — upgrades the grace window to the full session. */
  claim(): void {
    this.send({ type: "claim" });
    // Optimistically reflect the full session window for countdown UIs.
    if (this.state.phase === "admitted") {
      const sessionEndsAt = this.state.sessionDurationMs
        ? Date.now() + this.state.sessionDurationMs
        : this.state.sessionEndsAt;
      this.setState({ phase: "active", sessionEndsAt, secondsLeft: null });
    }
  }

  /** The Reactor session ended client-side; free the slot so the queue slides. */
  endSession(): void {
    this.send({ type: "session_ended" });
    this.setState({ sessionId: null, token: null, tokenExpiresAt: null });
  }

  /** Tear everything down. The instance is unusable afterwards. */
  destroy(): void {
    this.destroyed = true;
    this.failPending(new Error("client destroyed"));
    this.teardownSocket();
    this.clearRetry();
    this.clearRefresh();
    this.listeners.clear();
  }

  // ── JWT resolver for the Reactor SDK ──────────────────────────────────────

  /**
   * Resolver compatible with the Reactor SDK's `getJwt` option. Returns the
   * cached token while it's fresh, otherwise asks the server for a new one over
   * the WebSocket and resolves when it arrives.
   *
   * Bound as an arrow so it can be passed directly: `getJwt={queue.getJwt}`.
   */
  getJwt = async (): Promise<string> => {
    const now = Date.now();
    const fresh =
      this.state.token &&
      this.state.tokenExpiresAt &&
      this.state.tokenExpiresAt * 1000 - now > this.opts.tokenSkewMs;
    if (fresh) return this.state.token as string;

    // Socket gone (teardown / leave / brief reconnect): hand over the last
    // token we hold instead of throwing, so the SDK can finish in-flight
    // cleanup like DELETE /sessions during disconnect.
    if (this.state.token && (!this.socket || this.socket.readyState !== WebSocket.OPEN)) {
      return this.state.token;
    }
    return this.requestToken();
  };

  private requestToken(): Promise<string> {
    if (this.pendingToken) {
      return new Promise<string>((resolve, reject) => {
        const prev = this.pendingToken!;
        this.pendingToken = {
          resolve: (jwt) => {
            prev.resolve(jwt);
            resolve(jwt);
          },
          reject: (err) => {
            prev.reject(err);
            reject(err);
          },
          timer: prev.timer,
        };
      });
    }

    return new Promise<string>((resolve, reject) => {
      const socket = this.socket;
      if (!socket) {
        reject(new Error("queue is not connected; cannot mint token"));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingToken = null;
        reject(new Error("timed out waiting for a queue token"));
      }, this.opts.tokenRequestTimeoutMs);
      this.pendingToken = { resolve, reject, timer };

      // The SDK may call getJwt a hair before the socket finishes opening (or
      // during a brief reconnect). Send now if open, otherwise on the next open.
      if (socket.readyState === WebSocket.OPEN) {
        this.send({ type: "request_token" });
      } else {
        socket.addEventListener(
          "open",
          () => this.send({ type: "request_token" }),
          { once: true }
        );
      }
    });
  }

  /**
   * Keep the cached token warm: refresh it shortly before it expires so the SDK
   * never has to block on a round-trip mid-session. Best-effort; failures are
   * swallowed because the reactive {@link getJwt} path is the real guarantee.
   */
  private scheduleTokenRefresh(): void {
    this.clearRefresh();
    if (!this.state.tokenExpiresAt) return;
    const lead = this.state.tokenExpiresAt * 1000 - Date.now() - this.opts.tokenSkewMs;
    this.refreshTimer = setTimeout(
      () => {
        if (this.destroyed) return;
        if (this.state.phase === "admitted" || this.state.phase === "active") {
          this.requestToken().catch(() => {
            /* reactive getJwt will retry when the SDK next needs a token */
          });
        }
      },
      Math.max(1_000, lead)
    );
  }

  private clearRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private resolvePending(jwt: string): void {
    if (!this.pendingToken) return;
    clearTimeout(this.pendingToken.timer);
    this.pendingToken.resolve(jwt);
    this.pendingToken = null;
  }

  private failPending(err: Error): void {
    if (!this.pendingToken) return;
    clearTimeout(this.pendingToken.timer);
    this.pendingToken.reject(err);
    this.pendingToken = null;
  }

  // ── inbound message handling ──────────────────────────────────────────────

  private handleMessage(raw: string): void {
    const msg = parseServerMessage(raw);
    if (!msg) return;

    switch (msg.type) {
      case "queue_position":
        this.setState({
          phase: "queued",
          position: msg.position,
          total: msg.total,
          active: msg.active,
          capacity: msg.capacity,
        });
        break;

      case "admitted":
        this.setState({
          phase: this.state.phase === "active" ? "active" : "admitted",
          position: 0,
          total: 0,
          active: msg.active,
          capacity: msg.capacity,
          sessionId: msg.sessionId,
          sessionEndsAt: Date.now() + msg.graceMs,
          sessionDurationMs: msg.sessionDurationMs,
          secondsLeft: null,
        });
        break;

      case "token":
        this.setState({ token: msg.jwt, tokenExpiresAt: msg.expiresAt });
        this.resolvePending(msg.jwt);
        this.scheduleTokenRefresh();
        break;

      case "time_warning":
        this.setState({ secondsLeft: msg.secondsLeft, sessionEndsAt: msg.expiresAt });
        break;

      case "expired":
        this.failPending(new Error("session expired"));
        this.clearRefresh();
        // Keep the token (it's a short-lived JWT, not session-scoped) so the
        // SDK's teardown DELETE can still resolve one; it ages out on its own.
        this.setState({ phase: "expired", sessionId: null, reason: msg.reason });
        this.teardownSocket();
        break;

      case "rejected":
        this.failPending(new Error(`rejected: ${msg.reason}`));
        this.setState({ phase: "rejected", reason: msg.reason });
        this.teardownSocket();
        this.scheduleRetry();
        break;

      case "error":
        this.setState({ reason: msg.message });
        this.failPending(new Error(msg.message));
        break;
    }
  }

  private handleClose(): void {
    this.stopHeartbeat();
    // Only downgrade phase if we weren't already in a terminal state.
    if (["connecting", "queued", "admitted", "active"].includes(this.state.phase)) {
      this.setState({ phase: "disconnected" });
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private send(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private teardownSocket(): void {
    this.stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closing */
      }
      this.socket = null;
    }
  }

  private scheduleRetry(): void {
    if (this.opts.retryRejectedMs <= 0 || this.destroyed) return;
    this.clearRetry();
    this.retryTimer = setTimeout(() => this.connect(), this.opts.retryRejectedMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
