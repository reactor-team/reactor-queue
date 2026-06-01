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
  /** The capacity slot this member occupies. */
  slotId: string;
  /** Reactor session id once the slot's session is created (on claim); null during grace. */
  sessionId: string | null;
  /** Epoch ms when this member's slot is reclaimed (grace or full session). */
  expiresAt: number;
  warned: boolean;
  claimed: boolean;
}

/**
 * A capacity slot shared by up to `usersPerSession` members. Reserved at
 * admission; its Reactor session is created lazily on the first `claim()` so an
 * abandoned grace never orphans a GPU session.
 */
interface SlotRecord {
  slotId: string;
  /** Reactor session id, or null until the first member claims. */
  sessionId: string | null;
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
    private slotKey(slotId: string): string {
      return `slot:${slotId}`;
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

    private async getSlot(slotId: string): Promise<SlotRecord | undefined> {
      return this.room.storage.get<SlotRecord>(this.slotKey(slotId));
    }
    private async setSlot(record: SlotRecord): Promise<void> {
      await this.room.storage.put(this.slotKey(record.slotId), record);
    }
    private async deleteSlot(slotId: string): Promise<void> {
      await this.room.storage.delete(this.slotKey(slotId));
    }

    private async getAllMembers(): Promise<Map<string, MemberData>> {
      return this.room.storage.list<MemberData>({ prefix: "member:" });
    }
    private async getAllSlots(): Promise<Map<string, SlotRecord>> {
      return this.room.storage.list<SlotRecord>({ prefix: "slot:" });
    }

    private async getActiveMemberCount(): Promise<number> {
      return (await this.getAllMembers()).size;
    }

    private async getSlotCount(): Promise<number> {
      return (await this.getAllSlots()).size;
    }

    /** Number of slots whose Reactor session is actually created (live GPU sessions). */
    private async getCreatedSessionCount(): Promise<number> {
      let n = 0;
      for (const [, slot] of await this.getAllSlots()) if (slot.sessionId) n++;
      return n;
    }

    /** First slot with a free seat, or undefined. */
    private async findOpenSlot(): Promise<SlotRecord | undefined> {
      const cap = this.config.usersPerSession;
      for (const [, record] of await this.getAllSlots()) {
        if (record.members.length < cap) return record;
      }
      return undefined;
    }

    private async findSlotBySessionId(sessionId: string): Promise<SlotRecord | undefined> {
      for (const [, slot] of await this.getAllSlots()) {
        if (slot.sessionId === sessionId) return slot;
      }
      return undefined;
    }

    private genId(): string {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
        slots: await this.getAllSlots(),
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
      const slot = await this.findSlotBySessionId(sessionId);
      if (!slot) return { ok: false, message: "session_not_found" };
      for (const connId of [...slot.members]) {
        const member = await this.getMember(connId);
        if (member) {
          await this.releaseMember(connId, member, "server", { notify: true, stop: false });
        }
      }
      await this.closeSlot(slot.slotId, "admin", true);
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
              await this.claimMember(sender.id, member);
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
      const slots = await this.getAllSlots();
      const activeCount = await this.getActiveMemberCount();
      const createdSessions = [...slots].filter(([, s]) => s.sessionId).length;
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
            slotCount: slots.size,
            sessionCount: createdSessions,
            slots: [...slots].map(([, rec]) => ({
              slotId: rec.slotId,
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

        for (const [, slot] of await this.getAllSlots()) {
          // Only poll slots whose Reactor session actually exists.
          if (!slot.sessionId || slot.members.length === 0) continue;
          if (now - (slot.lastPollAt ?? 0) < this.config.pollIntervalMs) continue;

          const state = await this.api.getSessionState(slot.sessionId);
          if (CoordinatorClient.isTerminal(state)) {
            for (const connId of [...slot.members]) {
              const member = await this.getMember(connId);
              if (member) {
                await this.releaseMember(connId, member, "server", {
                  notify: true,
                  stop: false,
                });
              }
            }
            await this.closeSlot(slot.slotId, state ?? "CLOSED", false);
            freedAny = true;
          } else {
            await this.setSlot({ ...slot, lastPollAt: now });
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
      const slots = await this.getAllSlots();
      if (members.size === 0 && slots.size === 0) {
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

      for (const [, slot] of slots) {
        if (slot.sessionId && slot.members.length > 0) {
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
        const open = await this.findOpenSlot();
        const slotCount = await this.getSlotCount();
        // Reserve a seat in an open slot, or open a new slot if under the cap.
        if (!open && slotCount >= this.config.maxSessions) break;

        const connId = queue[0]!;
        if (this.connectionsById(connId).length === 0) {
          queue.shift();
          queueChanged = true;
          continue;
        }

        let slot: SlotRecord;
        if (open) {
          slot = open;
        } else {
          // No Reactor session yet — created lazily on claim to avoid orphans.
          slot = { slotId: this.genId(), sessionId: null, members: [], createdAt: Date.now() };
        }

        queue.shift();
        queueChanged = true;

        slot = { ...slot, members: [...slot.members, connId] };
        await this.setSlot(slot);

        await this.setMember(connId, {
          slotId: slot.slotId,
          sessionId: null,
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
        });
        // Token can be minted now (it's not session-scoped); the SDK uses it
        // after claim. getJwt/request_token keep it fresh.
        for (const conn of this.connectionsById(connId)) await this.mintAndSend(conn);
        admittedAny = true;
      }

      if (queueChanged) await this.setQueue(queue);
      if (admittedAny) await this.scheduleNextAlarm();
      this.scheduleBroadcast();
      if (queueChanged || admittedAny) this.scheduleAdminBroadcast();
    }

    /**
     * The member confirmed entry. Create the slot's Reactor session if it does
     * not exist yet (or reuse it for a multi-member slot), start the full
     * session timer, and hand back the session id to attach to.
     */
    private async claimMember(connId: string, member: MemberData): Promise<void> {
      const slot = await this.getSlot(member.slotId);
      if (!slot) {
        // Slot vanished (e.g. reaped); nothing to claim.
        return;
      }

      let sessionId = slot.sessionId;
      if (!sessionId) {
        try {
          sessionId = await this.api.createSession({
            model: this.config.model,
            webrtcVersion: this.config.webrtcVersion,
          });
        } catch (err) {
          this.reportError("createSession", err);
          this.send(
            this.connectionsById(connId)[0] ?? ({} as Party.Connection),
            { type: "error", message: "session_create_failed" }
          );
          return;
        }
        await this.setSlot({ ...slot, sessionId });
        this.config.hooks.onSessionCreated?.(sessionId);
      }

      const expiresAt = Date.now() + this.config.sessionDurationMs;
      await this.setMember(connId, {
        ...member,
        sessionId,
        expiresAt,
        warned: false,
        claimed: true,
      });

      this.sendTo(connId, {
        type: "session_ready",
        sessionId,
        sessionDurationMs: this.config.sessionDurationMs,
        expiresAt,
      });
      this.config.hooks.onUserEnteredSession?.(connId, sessionId);
      await this.scheduleNextAlarm();
      this.scheduleAdminBroadcast();
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
     * Remove a member from its slot. When the slot is empty, stop its Reactor
     * session (if one was ever created) and fire `onSessionClosed`.
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

      const slot = await this.getSlot(data.slotId);
      if (slot) {
        const nextMembers = slot.members.filter((id) => id !== connId);
        if (nextMembers.length === 0) {
          const shouldStop = (opts.stop ?? true) && this.config.stopSessionsOnExpiry;
          await this.closeSlot(slot.slotId, reason, shouldStop);
        } else {
          await this.setSlot({ ...slot, members: nextMembers });
        }
      }

      await this.deleteMember(connId);
    }

    /**
     * Tear down a slot: stop its Reactor session if one exists (and `stop`),
     * delete the record, fire `onSessionClosed`. A slot whose session was never
     * created (abandoned grace) closes with nothing to stop — no orphan.
     */
    private async closeSlot(slotId: string, reason: string, stop: boolean): Promise<void> {
      const slot = await this.getSlot(slotId);
      const sessionId = slot?.sessionId ?? null;
      if (stop && sessionId) {
        try {
          await this.api.stopSession(sessionId, `queue: ${reason}`);
        } catch (err) {
          this.reportError("stopSession", err);
        }
      }
      await this.deleteSlot(slotId);
      if (sessionId) this.config.hooks.onSessionClosed?.(sessionId, reason);
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
