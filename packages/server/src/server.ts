import type * as Party from "partykit/server";
import {
  ADMIN_MODE_QUERY_KEY,
  CLIENT_ID_QUERY_KEY,
  parseAdminClientMessage,
  parseClientMessage,
  type AdminServerMessage,
  type ServerMessage,
} from "@reactor-team/queue-protocol";
import { buildAdminSnapshot } from "./admin-snapshot";
import {
  resolveConfig,
  type ReactorQueueServerConfig,
  type ResolvedConfig,
} from "./config";
import { CoordinatorClient } from "./coordinator";

/** Per admitted member. Lives in durable storage under `member:<connId>`. */
interface MemberData {
  sessionId: string;
  /** Epoch ms when this member's slot is reclaimed (grace or full session). */
  expiresAt: number;
  warned: boolean;
  claimed: boolean;
}

/** One Reactor session shared by up to `usersPerSession` members. */
interface SessionRecord {
  sessionId: string;
  members: string[];
  createdAt: number;
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
 * export default createReactorQueueServer({ model: "helios" });
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
    private adminBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
    private adminBroadcastPending = false;

    constructor(readonly room: Party.Room) {}

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

    private memberKey(connId: string): string {
      return `member:${connId}`;
    }
    private sessionKey(sessionId: string): string {
      return `session:${sessionId}`;
    }

    private async getMember(connId: string): Promise<MemberData | undefined> {
      return this.room.storage.get<MemberData>(this.memberKey(connId));
    }
    private async setMember(connId: string, data: MemberData): Promise<void> {
      await this.room.storage.put(this.memberKey(connId), data);
    }
    private async deleteMember(connId: string): Promise<void> {
      await this.room.storage.delete(this.memberKey(connId));
    }

    private async getSessionRecord(sessionId: string): Promise<SessionRecord | undefined> {
      return this.room.storage.get<SessionRecord>(this.sessionKey(sessionId));
    }
    private async setSessionRecord(record: SessionRecord): Promise<void> {
      await this.room.storage.put(this.sessionKey(record.sessionId), record);
    }
    private async deleteSessionRecord(sessionId: string): Promise<void> {
      await this.room.storage.delete(this.sessionKey(sessionId));
    }

    private async getAllMembers(): Promise<Map<string, MemberData>> {
      return this.room.storage.list<MemberData>({ prefix: "member:" });
    }
    private async getAllSessionRecords(): Promise<Map<string, SessionRecord>> {
      return this.room.storage.list<SessionRecord>({ prefix: "session:" });
    }

    private async getActiveMemberCount(): Promise<number> {
      return (await this.getAllMembers()).size;
    }

    private async getSessionCount(): Promise<number> {
      return (await this.getAllSessionRecords()).size;
    }

    /** First session with a free seat, or undefined. */
    private async findOpenSession(): Promise<SessionRecord | undefined> {
      const cap = this.config.usersPerSession;
      for (const [, record] of await this.getAllSessionRecords()) {
        if (record.members.length < cap) return record;
      }
      return undefined;
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

    private sendAdmin(conn: Party.Connection, msg: AdminServerMessage) {
      const ws = conn as { readyState?: number };
      if (ws.readyState !== undefined && ws.readyState !== 1 /* OPEN */) return;
      try {
        conn.send(JSON.stringify(msg));
      } catch {
        /* connection closed */
      }
    }

    private sendAdminTo(connId: string, msg: AdminServerMessage) {
      for (const conn of this.connectionsById(connId)) this.sendAdmin(conn, msg);
    }

    private adminKey(connId: string): string {
      return `admin:${connId}`;
    }

    private async getAdminStatus(
      connId: string
    ): Promise<"pending" | "active" | undefined> {
      return this.room.storage.get<"pending" | "active">(this.adminKey(connId));
    }

    private async resolveClientIdForConn(connId: string): Promise<string | null> {
      return (await this.room.storage.get<string>(`conn:${connId}`)) ?? null;
    }

    private async buildSnapshot() {
      return buildAdminSnapshot({
        config: this.config,
        queue: await this.getQueue(),
        sessions: await this.getAllSessionRecords(),
        members: await this.getAllMembers(),
        resolveClientId: (connId) => this.resolveClientIdForConn(connId),
      });
    }

    private async getActiveAdminConnIds(): Promise<string[]> {
      const all = await this.room.storage.list<"pending" | "active">({ prefix: "admin:" });
      const out: string[] = [];
      for (const [key, status] of all) {
        if (status === "active") out.push(key.replace("admin:", ""));
      }
      return out;
    }

    private scheduleAdminBroadcast(): void {
      this.adminBroadcastPending = true;
      if (this.adminBroadcastTimer) return;
      this.adminBroadcastTimer = setTimeout(() => {
        this.adminBroadcastTimer = null;
        if (!this.adminBroadcastPending) return;
        this.adminBroadcastPending = false;
        void this.broadcastAdminSnapshots().catch((err) =>
          this.reportError("adminBroadcast", err)
        );
      }, 100);
    }

    private async broadcastAdminSnapshots(): Promise<void> {
      const admins = await this.getActiveAdminConnIds();
      if (admins.length === 0) return;
      const snapshot = await this.buildSnapshot();
      for (const connId of admins) this.sendAdminTo(connId, snapshot);
    }

    private async adminKickMember(connId: string): Promise<{ ok: boolean; message?: string }> {
      const member = await this.getMember(connId);
      if (!member) return { ok: false, message: "member_not_found" };
      await this.releaseMember(connId, member, "server", { notify: true, stop: true });
      await this.tryAdmitNext();
      this.scheduleAdminBroadcast();
      return { ok: true };
    }

    private async adminKickQueued(connId: string): Promise<{ ok: boolean; message?: string }> {
      const queue = await this.getQueue();
      const idx = queue.indexOf(connId);
      if (idx === -1) return { ok: false, message: "not_in_queue" };
      queue.splice(idx, 1);
      await this.setQueue(queue);
      for (const conn of this.connectionsById(connId)) {
        try {
          conn.close(1000, "evicted");
        } catch {
          /* already gone */
        }
      }
      this.scheduleBroadcast();
      this.scheduleAdminBroadcast();
      return { ok: true };
    }

    private async adminCloseSession(sessionId: string): Promise<{ ok: boolean; message?: string }> {
      const record = await this.getSessionRecord(sessionId);
      if (!record) return { ok: false, message: "session_not_found" };
      for (const connId of [...record.members]) {
        const member = await this.getMember(connId);
        if (member) {
          await this.releaseMember(connId, member, "server", { notify: true, stop: false });
        }
      }
      await this.closeSessionRecord(sessionId, "admin", true);
      await this.tryAdmitNext();
      this.scheduleAdminBroadcast();
      return { ok: true };
    }

    // ── connection lifecycle ────────────────────────────────────────────────

    async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
      try {
        const url = new URL(ctx.request.url);
        const isAdmin = url.searchParams.get(ADMIN_MODE_QUERY_KEY) === "1";

        if (isAdmin) {
          if (!this.config.adminPassword) {
            this.sendAdmin(conn, { type: "admin_rejected", reason: "admin_disabled" });
            conn.close(1008, "admin_disabled");
            return;
          }
          await this.room.storage.put(this.adminKey(conn.id), "pending");
          return;
        }

        const clientId = url.searchParams.get(CLIENT_ID_QUERY_KEY);
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
            await this.room.storage.delete(`cid:${clientId}`);
            await this.room.storage.delete(`conn:${entry.connId}`);
          }
          await this.setClientEntry(clientId, conn.id);
        }

        const queue = await this.getQueue();
        queue.push(conn.id);
        await this.setQueue(queue);
        this.config.hooks.onUserConnected?.(conn.id);
        await this.tryAdmitNext();
        this.scheduleAdminBroadcast();
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
        const adminStatus = await this.getAdminStatus(conn.id);
        if (adminStatus) {
          await this.room.storage.delete(this.adminKey(conn.id));
          return;
        }

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
          this.scheduleAdminBroadcast();
        }

        const member = await this.getMember(conn.id);
        if (member) {
          await this.releaseMember(conn.id, member, "server", { notify: false });
          await this.tryAdmitNext();
        }

        this.config.hooks.onUserDisconnected?.(conn.id);
      } catch (err) {
        this.reportError("onClose", err);
      }
    }

    async onMessage(raw: string, sender: Party.Connection) {
      const adminStatus = await this.getAdminStatus(sender.id);
      if (adminStatus) {
        const adminMsg = parseAdminClientMessage(raw);
        try {
          if (adminStatus === "pending") {
            if (adminMsg?.type !== "admin_auth") {
              this.sendAdmin(sender, { type: "admin_rejected", reason: "auth_required" });
              sender.close(1008, "auth_required");
              return;
            }
            if (adminMsg.password !== this.config.adminPassword) {
              this.sendAdmin(sender, { type: "admin_rejected", reason: "invalid_password" });
              sender.close(1008, "invalid_password");
              await this.room.storage.delete(this.adminKey(sender.id));
              return;
            }
            await this.room.storage.put(this.adminKey(sender.id), "active");
            this.sendAdmin(sender, { type: "admin_ready" });
            this.sendAdmin(sender, await this.buildSnapshot());
            return;
          }

          if (!adminMsg) return;

          switch (adminMsg.type) {
            case "admin_refresh": {
              this.sendAdmin(sender, await this.buildSnapshot());
              break;
            }
            case "admin_kick_member": {
              const result = await this.adminKickMember(adminMsg.connId);
              this.sendAdmin(sender, {
                type: "admin_action_result",
                action: "kick_member",
                ok: result.ok,
                message: result.message,
              });
              if (result.ok) this.sendAdmin(sender, await this.buildSnapshot());
              break;
            }
            case "admin_kick_queued": {
              const result = await this.adminKickQueued(adminMsg.connId);
              this.sendAdmin(sender, {
                type: "admin_action_result",
                action: "kick_queued",
                ok: result.ok,
                message: result.message,
              });
              if (result.ok) this.sendAdmin(sender, await this.buildSnapshot());
              break;
            }
            case "admin_close_session": {
              const result = await this.adminCloseSession(adminMsg.sessionId);
              this.sendAdmin(sender, {
                type: "admin_action_result",
                action: "close_session",
                ok: result.ok,
                message: result.message,
              });
              if (result.ok) this.sendAdmin(sender, await this.buildSnapshot());
              break;
            }
            case "admin_auth":
              break;
          }
        } catch (err) {
          this.reportError(`onMessage:admin:${adminMsg?.type ?? "unknown"}`, err);
        }
        return;
      }

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
            const member = await this.getMember(sender.id);
            if (member && !member.claimed) {
              await this.setMember(sender.id, {
                ...member,
                expiresAt: Date.now() + this.config.sessionDurationMs,
                warned: false,
                claimed: true,
              });
              await this.scheduleNextAlarm();
            }
            break;
          }

          case "request_token": {
            const member = await this.getMember(sender.id);
            if (member) await this.mintAndSend(sender);
            break;
          }

          case "session_ended": {
            const member = await this.getMember(sender.id);
            if (member) {
              await this.releaseMember(sender.id, member, "server", {
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

    async onRequest(_req: Party.Request) {
      const queue = await this.getQueue();
      const sessions = await this.getAllSessionRecords();
      const activeCount = await this.getActiveMemberCount();
      const c = this.config;
      return new Response(
        JSON.stringify(
          {
            maxSessions: c.maxSessions,
            usersPerSession: c.usersPerSession,
            capacity: c.capacity,
            sessionDurationMs: c.sessionDurationMs,
            admissionGraceMs: c.admissionGraceMs,
            model: c.model,
            tokenTtlSeconds: c.tokenTtlSeconds,
            pollIntervalMs: c.pollIntervalMs,
            queueLength: queue.length,
            activeCount,
            sessionCount: sessions.size,
            sessions: [...sessions].map(([, rec]) => ({
              sessionId: rec.sessionId,
              members: rec.members,
              msSinceCreated: Date.now() - rec.createdAt,
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
        const members = await this.getAllMembers();
        const now = Date.now();
        let freedAny = false;

        for (const [key, data] of members) {
          const connId = key.replace("member:", "");

          if (now >= data.expiresAt) {
            const reason = data.claimed ? "timeout" : "grace_timeout";
            await this.releaseMember(connId, data, reason, { notify: true });
            freedAny = true;
            continue;
          }

          if (data.claimed && !data.warned && now >= data.expiresAt - this.config.warningBeforeMs) {
            this.sendTo(connId, {
              type: "time_warning",
              secondsLeft: Math.round((data.expiresAt - now) / 1000),
              expiresAt: data.expiresAt,
            });
            await this.setMember(connId, { ...data, warned: true });
          }
        }

        for (const [, record] of await this.getAllSessionRecords()) {
          if (record.members.length === 0) continue;
          if (now - (record.lastPollAt ?? 0) < this.config.pollIntervalMs) continue;

          const state = await this.api.getSessionState(record.sessionId);
          if (CoordinatorClient.isTerminal(state)) {
            for (const connId of [...record.members]) {
              const member = await this.getMember(connId);
              if (member) {
                await this.releaseMember(connId, member, "server", {
                  notify: true,
                  stop: false,
                });
              }
            }
            await this.closeSessionRecord(record.sessionId, state ?? "CLOSED", false);
            freedAny = true;
          } else {
            await this.setSessionRecord({ ...record, lastPollAt: now });
          }
        }

        if (freedAny) await this.tryAdmitNext();
        await this.broadcastPositions();
        this.scheduleAdminBroadcast();
      } catch (err) {
        this.reportError("onAlarm", err);
      } finally {
        await this.scheduleNextAlarm();
      }
    }

    private async scheduleNextAlarm(): Promise<void> {
      const members = await this.getAllMembers();
      const sessions = await this.getAllSessionRecords();
      if (members.size === 0 && sessions.size === 0) {
        await this.room.storage.deleteAlarm();
        return;
      }

      const now = Date.now();
      let earliest = Infinity;

      for (const [, data] of members) {
        earliest = Math.min(earliest, data.expiresAt);
        if (data.claimed && !data.warned) {
          earliest = Math.min(earliest, data.expiresAt - this.config.warningBeforeMs);
        }
      }

      for (const [, record] of sessions) {
        if (record.members.length > 0) {
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
      let queueChanged = false;
      let admittedAny = false;

      while (queue.length > 0) {
        const open = await this.findOpenSession();
        const sessionCount = await this.getSessionCount();
        if (!open && sessionCount >= this.config.maxSessions) break;

        const connId = queue[0]!;
        if (this.connectionsById(connId).length === 0) {
          queue.shift();
          queueChanged = true;
          continue;
        }

        let sessionId: string;
        let record: SessionRecord;

        if (open) {
          record = open;
          sessionId = record.sessionId;
        } else {
          try {
            sessionId = await this.api.createSession({
              model: this.config.model,
              webrtcVersion: this.config.webrtcVersion,
            });
          } catch (err) {
            this.reportError("createSession", err);
            break;
          }
          record = {
            sessionId,
            members: [],
            createdAt: Date.now(),
          };
          await this.setSessionRecord(record);
          this.config.hooks.onSessionCreated?.(sessionId);
        }

        queue.shift();
        queueChanged = true;

        record = {
          ...record,
          members: [...record.members, connId],
        };
        await this.setSessionRecord(record);

        await this.setMember(connId, {
          sessionId,
          expiresAt: Date.now() + this.config.admissionGraceMs,
          warned: false,
          claimed: false,
        });

        const activeCount = await this.getActiveMemberCount();
        this.sendTo(connId, {
          type: "admitted",
          active: activeCount,
          capacity: this.config.capacity,
          graceMs: this.config.admissionGraceMs,
          sessionDurationMs: this.config.sessionDurationMs,
          sessionId,
        });
        for (const conn of this.connectionsById(connId)) await this.mintAndSend(conn);
        this.config.hooks.onUserEnteredSession?.(connId, sessionId);
        admittedAny = true;
      }

      if (queueChanged) await this.setQueue(queue);
      if (admittedAny) await this.scheduleNextAlarm();
      this.scheduleBroadcast();
      if (queueChanged || admittedAny) this.scheduleAdminBroadcast();
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
     * Remove a member from their session. When the session is empty, optionally
     * stop the Reactor session and fire `onSessionClosed`.
     */
    private async releaseMember(
      connId: string,
      data: MemberData,
      reason: "timeout" | "grace_timeout" | "server",
      opts: { notify: boolean; stop?: boolean }
    ): Promise<void> {
      if (opts.notify) {
        this.sendTo(connId, { type: "expired", reason });
      }

      const record = await this.getSessionRecord(data.sessionId);
      if (record) {
        const nextMembers = record.members.filter((id) => id !== connId);
        if (nextMembers.length === 0) {
          const shouldStop =
            (opts.stop ?? true) && this.config.stopSessionsOnExpiry;
          await this.closeSessionRecord(data.sessionId, reason, shouldStop);
        } else {
          await this.setSessionRecord({ ...record, members: nextMembers });
        }
      }

      await this.deleteMember(connId);
    }

    private async closeSessionRecord(
      sessionId: string,
      reason: string,
      stop: boolean
    ): Promise<void> {
      if (stop) {
        try {
          await this.api.stopSession(sessionId, `queue: ${reason}`);
        } catch (err) {
          this.reportError("stopSession", err);
        }
      }
      await this.deleteSessionRecord(sessionId);
      this.config.hooks.onSessionClosed?.(sessionId, reason);
      this.scheduleAdminBroadcast();
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
      const activeCount = await this.getActiveMemberCount();
      for (let i = 0; i < queue.length; i++) {
        const connId = queue[i]!;
        this.sendTo(connId, {
          type: "queue_position",
          position: i + 1,
          total: queue.length,
          active: activeCount,
          capacity: this.config.capacity,
        });
      }
    }
  };
}
