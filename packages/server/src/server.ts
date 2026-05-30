import type * as Party from "partykit/server";
import {
  CLIENT_ID_QUERY_KEY,
  parseClientMessage,
  type ServerMessage,
} from "@reactor-team/queue-protocol";
import {
  resolveConfig,
  type ReactorQueueServerConfig,
  type ResolvedConfig,
} from "./config";
import { CoordinatorClient } from "./coordinator";

/** One admitted slot. Lives in durable storage under `session:<connId>`. */
interface SessionData {
  /** Epoch ms when this slot is reclaimed (grace deadline, or full-session deadline once claimed). */
  expiresAt: number;
  /** Whether the pre-expiry `time_warning` has already been sent. */
  warned: boolean;
  /** False = holding a grace slot; true = user entered and has the full budget. */
  claimed: boolean;
  /** Reactor session id once the client reports it. Enables stop + poll. */
  sessionId?: string;
  /** Epoch ms of the last reconciliation poll against Reactor. */
  lastPollAt?: number;
}

/** Maps a stable browser id → its current connection, for duplicate-tab eviction. */
interface ClientEntry {
  connId: string;
  lastSeen: number;
}

/**
 * Build a PartyKit `Server` class implementing the Reactor queue. Use it as the
 * default export of your PartyKit entrypoint:
 *
 * ```ts
 * // partykit/server.ts
 * import { createReactorQueueServer } from "@reactor-team/queue-server";
 * export default createReactorQueueServer({ maxConcurrent: 3 });
 * ```
 */
export function createReactorQueueServer(
  config: ReactorQueueServerConfig = {}
): new (room: Party.Room) => Party.Server {
  return class ReactorQueueServer implements Party.Server {
    options: Party.ServerOptions = { hibernate: true };

    private cfg: ResolvedConfig | null = null;
    private coordinator: CoordinatorClient | null = null;
    private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
    private broadcastPending = false;

    constructor(readonly room: Party.Room) {}

    // ── lazy config / coordinator (env is on room) ─────────────────────────

    private get config(): ResolvedConfig {
      if (!this.cfg) {
        this.cfg = resolveConfig(config, this.room.env as Record<string, unknown>);
      }
      return this.cfg;
    }

    private get api(): CoordinatorClient {
      if (!this.coordinator) {
        const c = this.config;
        this.coordinator = new CoordinatorClient({
          baseUrl: c.coordinatorUrl,
          apiKey: c.apiKey,
          apiVersion: c.apiVersion,
        });
      }
      return this.coordinator;
    }

    private reportError(where: string, error: unknown) {
      console.error(`[reactor-queue] ${where}`, error);
      try {
        this.config.hooks.onError?.(where, error);
      } catch {
        /* hook must never throw the server over */
      }
    }

    // ── storage helpers ────────────────────────────────────────────────────

    private async getQueue(): Promise<string[]> {
      return (await this.room.storage.get<string[]>("queue")) ?? [];
    }
    private async setQueue(queue: string[]): Promise<void> {
      await this.room.storage.put("queue", queue);
    }
    private async getSession(connId: string): Promise<SessionData | undefined> {
      return this.room.storage.get<SessionData>(`session:${connId}`);
    }
    private async setSession(connId: string, data: SessionData): Promise<void> {
      await this.room.storage.put(`session:${connId}`, data);
    }
    private async deleteSession(connId: string): Promise<void> {
      await this.room.storage.delete(`session:${connId}`);
    }
    private async getAllSessions(): Promise<Map<string, SessionData>> {
      return this.room.storage.list<SessionData>({ prefix: "session:" });
    }
    private async getActiveCount(): Promise<number> {
      return (await this.getAllSessions()).size;
    }

    private async getClientEntry(clientId: string): Promise<ClientEntry | undefined> {
      return this.room.storage.get<ClientEntry>(`cid:${clientId}`);
    }
    private async setClientEntry(clientId: string, connId: string): Promise<void> {
      await this.room.storage.put(`cid:${clientId}`, { connId, lastSeen: Date.now() });
      await this.room.storage.put(`conn:${connId}`, clientId);
    }

    private connectionsById(connId: string): Party.Connection[] {
      const out: Party.Connection[] = [];
      for (const conn of this.room.getConnections()) {
        if (conn.id === connId) out.push(conn);
      }
      return out;
    }

    private send(conn: Party.Connection, msg: ServerMessage) {
      // The connection may close mid-flight (e.g. while a token is being minted
      // over the network), which makes send() throw. Skip closed sockets and
      // never let a stray send crash a handler.
      const ws = conn as { readyState?: number };
      if (ws.readyState !== undefined && ws.readyState !== 1 /* OPEN */) return;
      try {
        conn.send(JSON.stringify(msg));
      } catch {
        /* connection closed between the check and the send */
      }
    }
    private sendTo(connId: string, msg: ServerMessage) {
      for (const conn of this.connectionsById(connId)) this.send(conn, msg);
    }

    // ── connection lifecycle ────────────────────────────────────────────────

    async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
      try {
        const clientId = new URL(ctx.request.url).searchParams.get(CLIENT_ID_QUERY_KEY);
        if (clientId) {
          const entry = await this.getClientEntry(clientId);
          if (entry && entry.connId !== conn.id) {
            const alive =
              this.connectionsById(entry.connId).length > 0 &&
              Date.now() - entry.lastSeen < this.config.heartbeatStaleMs;
            if (alive) {
              this.send(conn, { type: "rejected", reason: "already_connected" });
              conn.close(1008, "already_connected");
              return;
            }
            // Stale ghost connection — evict and take over its place.
            await this.room.storage.delete(`cid:${clientId}`);
            await this.room.storage.delete(`conn:${entry.connId}`);
          }
          await this.setClientEntry(clientId, conn.id);
        }

        const queue = await this.getQueue();
        queue.push(conn.id);
        await this.setQueue(queue);
        await this.tryAdmitNext();
      } catch (err) {
        this.reportError("onConnect", err);
        try {
          this.send(conn, { type: "rejected", reason: "server_error" });
          conn.close(1011, "connect_failed");
        } catch {
          /* connection already gone */
        }
      }
    }

    async onClose(conn: Party.Connection) {
      try {
        const clientId = await this.room.storage.get<string>(`conn:${conn.id}`);
        if (clientId) {
          const entry = await this.getClientEntry(clientId);
          if (entry?.connId === conn.id) {
            await this.room.storage.delete(`cid:${clientId}`);
          }
          await this.room.storage.delete(`conn:${conn.id}`);
        }

        const queue = await this.getQueue();
        const idx = queue.indexOf(conn.id);
        if (idx !== -1) {
          queue.splice(idx, 1);
          await this.setQueue(queue);
          this.scheduleBroadcast();
        }

        const session = await this.getSession(conn.id);
        if (session) {
          // Tab closed / network dropped while holding a slot: reap immediately
          // rather than waiting for Reactor's own idle timeout.
          await this.releaseSession(conn.id, session, "server", { notify: false });
          await this.tryAdmitNext();
        }
      } catch (err) {
        this.reportError("onClose", err);
      }
    }

    async onMessage(raw: string, sender: Party.Connection) {
      const msg = parseClientMessage(raw);
      if (!msg) return;

      try {
        switch (msg.type) {
          case "heartbeat": {
            const clientId = await this.room.storage.get<string>(`conn:${sender.id}`);
            if (clientId) {
              const entry = await this.getClientEntry(clientId);
              if (entry?.connId === sender.id) {
                await this.room.storage.put(`cid:${clientId}`, {
                  ...entry,
                  lastSeen: Date.now(),
                });
              }
            }
            break;
          }

          case "claim": {
            const session = await this.getSession(sender.id);
            if (session && !session.claimed) {
              await this.setSession(sender.id, {
                ...session,
                expiresAt: Date.now() + this.config.sessionDurationMs,
                warned: false,
                claimed: true,
              });
              this.config.hooks.onClaim?.(sender.id);
              await this.scheduleNextAlarm();
            }
            break;
          }

          case "request_token": {
            // Only admitted/active slot-holders may obtain a token.
            const session = await this.getSession(sender.id);
            if (session) await this.mintAndSend(sender);
            break;
          }

          case "session_started": {
            const session = await this.getSession(sender.id);
            if (session && msg.sessionId) {
              await this.setSession(sender.id, { ...session, sessionId: msg.sessionId });
              await this.scheduleNextAlarm();
            }
            break;
          }

          case "session_ended": {
            const session = await this.getSession(sender.id);
            if (session) {
              // Client already tore down the Reactor session; just free the slot.
              await this.releaseSession(sender.id, session, "server", {
                notify: false,
                stop: false,
              });
              await this.tryAdmitNext();
            }
            break;
          }

          case "leave": {
            sender.close(1000, "left");
            break;
          }
        }
      } catch (err) {
        this.reportError(`onMessage:${msg.type}`, err);
      }
    }

    /** HTTP introspection endpoint — handy for `curl`ing room state while debugging. */
    async onRequest(_req: Party.Request) {
      const queue = await this.getQueue();
      const sessions = await this.getAllSessions();
      const c = this.config;
      return new Response(
        JSON.stringify(
          {
            maxConcurrent: c.maxConcurrent,
            sessionDurationMs: c.sessionDurationMs,
            admissionGraceMs: c.admissionGraceMs,
            tokenTtlSeconds: c.tokenTtlSeconds,
            pollIntervalMs: c.pollIntervalMs,
            queueLength: queue.length,
            activeCount: sessions.size,
            sessions: [...sessions].map(([k, v]) => ({
              connId: k.replace("session:", ""),
              claimed: v.claimed,
              hasSession: Boolean(v.sessionId),
              msLeft: Math.max(0, v.expiresAt - Date.now()),
            })),
          },
          null,
          2
        ),
        { headers: { "content-type": "application/json" } }
      );
    }

    // ── alarm: warnings, expiry, and session reconciliation ──────────────────

    async onAlarm() {
      try {
        const sessions = await this.getAllSessions();
        const now = Date.now();
        let freedAny = false;

        for (const [key, data] of sessions) {
          const connId = key.replace("session:", "");

          if (now >= data.expiresAt) {
            const reason = data.claimed ? "timeout" : "grace_timeout";
            await this.releaseSession(connId, data, reason, { notify: true });
            this.config.hooks.onExpire?.(connId, data.sessionId, reason);
            freedAny = true;
            continue;
          }

          if (data.claimed && !data.warned && now >= data.expiresAt - this.config.warningBeforeMs) {
            this.sendTo(connId, {
              type: "time_warning",
              secondsLeft: Math.round((data.expiresAt - now) / 1000),
              expiresAt: data.expiresAt,
            });
            await this.setSession(connId, { ...data, warned: true });
            continue;
          }

          // Reconcile a live session against Reactor to catch a missed drop-out.
          if (
            data.claimed &&
            data.sessionId &&
            now - (data.lastPollAt ?? 0) >= this.config.pollIntervalMs
          ) {
            const state = await this.api.getSessionState(data.sessionId);
            if (CoordinatorClient.isTerminal(state)) {
              await this.releaseSession(connId, data, "server", { notify: true, stop: false });
              this.config.hooks.onSessionReaped?.(connId, data.sessionId, state ?? "CLOSED");
              freedAny = true;
            } else {
              await this.setSession(connId, { ...data, lastPollAt: now });
            }
          }
        }

        if (freedAny) await this.tryAdmitNext();
        await this.broadcastPositions();
      } catch (err) {
        this.reportError("onAlarm", err);
      } finally {
        await this.scheduleNextAlarm();
      }
    }

    private async scheduleNextAlarm(): Promise<void> {
      const sessions = await this.getAllSessions();
      if (sessions.size === 0) {
        await this.room.storage.deleteAlarm();
        return;
      }

      const now = Date.now();
      let earliest = Infinity;
      for (const [, data] of sessions) {
        earliest = Math.min(earliest, data.expiresAt);
        if (data.claimed && !data.warned) {
          earliest = Math.min(earliest, data.expiresAt - this.config.warningBeforeMs);
        }
        if (data.claimed && data.sessionId) {
          earliest = Math.min(earliest, now + this.config.pollIntervalMs);
        }
      }

      if (earliest !== Infinity) {
        await this.room.storage.setAlarm(Math.max(earliest, now + 100));
      }
    }

    // ── admission + token minting ────────────────────────────────────────────

    private async tryAdmitNext() {
      const queue = await this.getQueue();
      let activeCount = await this.getActiveCount();
      let admittedAny = false;
      let queueChanged = false;

      while (activeCount < this.config.maxConcurrent && queue.length > 0) {
        const connId = queue.shift()!;
        queueChanged = true;
        if (this.connectionsById(connId).length === 0) continue; // dead/hibernated; drop

        activeCount++;
        await this.setSession(connId, {
          expiresAt: Date.now() + this.config.admissionGraceMs,
          warned: false,
          claimed: false,
        });
        this.sendTo(connId, {
          type: "admitted",
          active: activeCount,
          maxConcurrent: this.config.maxConcurrent,
          graceMs: this.config.admissionGraceMs,
          sessionDurationMs: this.config.sessionDurationMs,
        });
        // Hand over the first JWT right away so the client can connect.
        for (const conn of this.connectionsById(connId)) await this.mintAndSend(conn);
        this.config.hooks.onAdmit?.(connId);
        admittedAny = true;
      }

      if (queueChanged) await this.setQueue(queue);
      if (admittedAny) await this.scheduleNextAlarm();
      this.scheduleBroadcast();
    }

    private async mintAndSend(conn: Party.Connection): Promise<void> {
      try {
        const { jwt, expiresAt } = await this.api.mintToken(this.config.tokenTtlSeconds);
        this.send(conn, { type: "token", jwt, expiresAt });
      } catch (err) {
        this.reportError("mintToken", err);
        this.send(conn, { type: "error", message: "token_mint_failed" });
      }
    }

    /**
     * Free a slot: optionally notify the client, optionally stop the underlying
     * Reactor session, then delete the durable record.
     */
    private async releaseSession(
      connId: string,
      data: SessionData,
      reason: "timeout" | "grace_timeout" | "server",
      opts: { notify: boolean; stop?: boolean }
    ): Promise<void> {
      if (opts.notify) {
        this.sendTo(connId, { type: "expired", reason });
      }
      const shouldStop = (opts.stop ?? true) && this.config.stopSessionsOnExpiry && data.sessionId;
      if (shouldStop && data.sessionId) {
        try {
          await this.api.stopSession(data.sessionId);
        } catch (err) {
          this.reportError("stopSession", err);
        }
      }
      await this.deleteSession(connId);
    }

    // ── position broadcasting (coalesced) ─────────────────────────────────────

    private scheduleBroadcast(): void {
      this.broadcastPending = true;
      if (this.broadcastTimer) return;
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = null;
        if (!this.broadcastPending) return;
        this.broadcastPending = false;
        void this.broadcastPositions().catch((err) => this.reportError("broadcast", err));
      }, 100);
    }

    private async broadcastPositions() {
      const queue = await this.getQueue();
      const activeCount = await this.getActiveCount();
      for (let i = 0; i < queue.length; i++) {
        const connId = queue[i]!;
        this.sendTo(connId, {
          type: "queue_position",
          position: i + 1,
          total: queue.length,
          active: activeCount,
          maxConcurrent: this.config.maxConcurrent,
        });
      }
    }
  };
}
