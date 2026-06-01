import PartySocket from "partysocket";
import {
  ADMIN_MODE_QUERY_KEY,
  DEFAULT_ROOM,
  parseAdminServerMessage,
  type AdminClientMessage,
} from "@reactor-team/queue-protocol";
import {
  INITIAL_ADMIN_STATE,
  type AdminPasswordSource,
  type AdminState,
  type ReactorQueueAdminClientOptions,
} from "./admin-types";

type Listener = (state: AdminState) => void;

async function resolvePassword(source: AdminPasswordSource): Promise<string> {
  if (typeof source === "function") return source();
  return source;
}

/**
 * WebSocket client for queue admin mode. Does not join the FIFO queue; after
 * auth it receives {@link AdminSnapshotMessage} updates and can kick members or
 * close sessions.
 */
export class ReactorQueueAdminClient {
  private readonly opts: Required<
    Omit<ReactorQueueAdminClientOptions, "password" | "room" | "party">
  > & { room: string; party?: string; password: AdminPasswordSource };

  private socket: PartySocket | null = null;
  private destroyed = false;
  private state: AdminState = { ...INITIAL_ADMIN_STATE };
  private listeners = new Set<Listener>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ReactorQueueAdminClientOptions) {
    this.opts = {
      host: options.host,
      room: options.room ?? DEFAULT_ROOM,
      party: options.party,
      password: options.password,
      autoConnect: options.autoConnect ?? false,
      refreshIntervalMs: options.refreshIntervalMs ?? 0,
    };
    if (this.opts.autoConnect) this.connect();
  }

  getState(): AdminState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<AdminState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  connect(): void {
    if (this.destroyed) return;
    this.teardownSocket();
    this.setState({ ...INITIAL_ADMIN_STATE, phase: "connecting" });

    const socket = new PartySocket({
      host: this.opts.host,
      room: this.opts.room,
      party: this.opts.party,
      query: { [ADMIN_MODE_QUERY_KEY]: "1" },
    });
    this.socket = socket;

    socket.addEventListener("open", () => {
      void this.authenticate();
    });
    socket.addEventListener("message", (evt) => this.handleMessage(String(evt.data)));
    socket.addEventListener("close", () => {
      if (this.state.phase === "connecting" || this.state.phase === "ready") {
        this.setState({ phase: "disconnected" });
      }
    });
  }

  disconnect(): void {
    this.teardownSocket();
    this.setState({ phase: "idle" });
  }

  destroy(): void {
    this.destroyed = true;
    this.teardownSocket();
    this.listeners.clear();
  }

  refresh(): void {
    this.send({ type: "admin_refresh" });
  }

  kickMember(connId: string): void {
    this.send({ type: "admin_kick_member", connId });
  }

  kickQueued(connId: string): void {
    this.send({ type: "admin_kick_queued", connId });
  }

  closeSession(sessionId: string): void {
    this.send({ type: "admin_close_session", sessionId });
  }

  private async authenticate(): Promise<void> {
    try {
      const password = await resolvePassword(this.opts.password);
      this.send({ type: "admin_auth", password });
    } catch (err) {
      this.setState({
        phase: "rejected",
        reason: err instanceof Error ? err.message : "password_resolve_failed",
      });
      this.teardownSocket();
    }
  }

  private handleMessage(raw: string): void {
    const msg = parseAdminServerMessage(raw);
    if (!msg) return;

    switch (msg.type) {
      case "admin_ready":
        this.setState({ phase: "ready", reason: null });
        this.startRefreshTimer();
        break;
      case "admin_snapshot":
        this.setState({ phase: "ready", snapshot: msg });
        break;
      case "admin_rejected":
        this.setState({ phase: "rejected", reason: msg.reason });
        this.teardownSocket();
        break;
      case "admin_action_result":
        this.setState({ lastAction: msg });
        break;
    }
  }

  private send(msg: AdminClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private startRefreshTimer(): void {
    this.clearRefreshTimer();
    if (this.opts.refreshIntervalMs <= 0) return;
    this.refreshTimer = setInterval(() => {
      if (this.state.phase === "ready") this.refresh();
    }, this.opts.refreshIntervalMs);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private teardownSocket(): void {
    this.clearRefreshTimer();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closing */
      }
      this.socket = null;
    }
  }
}
