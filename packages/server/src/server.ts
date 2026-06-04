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
import { resolveConfig, type ReactorQueueServerConfig, type ResolvedConfig } from "./config";
import type { ReleaseSessionContext } from "./config";
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
  /** True while a claim is mid-flight (session being acquired) to reject duplicates. */
  claiming?: boolean;
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
    // Coalescing flags. Set during a handler, flushed once before it returns —
    // never across the hibernation boundary, so no in-memory timer is needed.
    private positionsDirty = false;
    private adminDirty = false;

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

    /**
     * Obtain a session id for a slot's first claim. Uses the configured
     * `acquireSession` override, or creates one via the Reactor API by default.
     */
    private async runAcquire(model: string): Promise<string> {
      if (this.config.acquireSession) return this.config.acquireSession({ model });
      return this.api.createSession({ model, webrtcVersion: this.config.webrtcVersion });
    }

    /**
     * A user left a session. Uses the configured `releaseSession` override, or by
     * default deletes the session via the Reactor API once the last member leaves
     * (subject to `stopSessionsOnExpiry`). Never throws into the caller.
     */
    private async runRelease(ctx: ReleaseSessionContext): Promise<void> {
      try {
        if (this.config.releaseSession) {
          await this.config.releaseSession(ctx);
          return;
        }
        if (ctx.lastMember && this.config.stopSessionsOnExpiry) {
          await this.api.stopSession(ctx.sessionId, `queue: ${ctx.reason}`);
        }
      } catch (err) {
        this.reportError("releaseSession", err);
      }
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

    // ── queue: ordered keys, not one array ───────────────────────────────────
    // Each waiter is its own storage entry `q:<zero-padded seq>` → connId, with a
    // reverse lookup `qpos:<connId>` → key. This makes enqueue/dequeue/position
    // lookups O(1) and removes the 128 KiB single-value cap, so the line can grow
    // far past the ~3k a single JSON array allowed. `qseq` is a monotonic counter
    // for FIFO ordering; `qcount` is the O(1) length.

    private queueItemKey(seq: number): string {
      return `q:${String(seq).padStart(16, "0")}`;
    }
    private async getQueueSeq(): Promise<number> {
      return (await this.room.storage.get<number>("qseq")) ?? 0;
    }
    private async getQueueCount(): Promise<number> {
      return (await this.room.storage.get<number>("qcount")) ?? 0;
    }
    private async isQueued(connId: string): Promise<boolean> {
      return Boolean(await this.room.storage.get<string>(`qpos:${connId}`));
    }
    private async enqueue(connId: string): Promise<void> {
      if (await this.isQueued(connId)) return;
      const seq = await this.getQueueSeq();
      const key = this.queueItemKey(seq);
      await this.room.storage.put(key, connId);
      await this.room.storage.put(`qpos:${connId}`, key);
      await this.room.storage.put("qseq", seq + 1);
      await this.room.storage.put("qcount", (await this.getQueueCount()) + 1);
    }
    /** Remove a waiter from the queue (by connId). Returns true if it was queued. */
    private async dequeue(connId: string): Promise<boolean> {
      const key = await this.room.storage.get<string>(`qpos:${connId}`);
      if (!key) return false;
      await this.room.storage.delete(key);
      await this.room.storage.delete(`qpos:${connId}`);
      await this.room.storage.put("qcount", Math.max(0, (await this.getQueueCount()) - 1));
      return true;
    }
    /** Full FIFO list of waiting connIds. O(N) — used for broadcasts (no approximation). */
    private async listQueue(): Promise<string[]> {
      const items = await this.room.storage.list<string>({ prefix: "q:" });
      return [...items.values()];
    }
    /** Front `limit` waiting entries `[key, connId]` in FIFO order, after `startAfter`. */
    private async frontQueue(limit: number, startAfter?: string): Promise<[string, string][]> {
      const items = await this.room.storage.list<string>({ prefix: "q:", limit, startAfter });
      return [...items.entries()];
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
      await this.room.storage.put(`cid:${clientId}`, { connId });
      await this.room.storage.put(`conn:${connId}`, clientId);
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
    // O(1) lookup via the platform connection registry (survives hibernation),
    // instead of scanning all connections.
    private sendTo(connId: string, msg: ServerMessage) {
      const conn = this.room.getConnection(connId);
      if (conn) this.send(conn, msg);
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
      const conn = this.room.getConnection(connId);
      if (conn) this.sendAdmin(conn, msg);
    }

    private adminKey(connId: string): string {
      return `admin:${connId}`;
    }

    private async getAdminStatus(connId: string): Promise<"pending" | "active" | undefined> {
      return this.room.storage.get<"pending" | "active">(this.adminKey(connId));
    }

    private async resolveClientIdForConn(connId: string): Promise<string | null> {
      return (await this.room.storage.get<string>(`conn:${connId}`)) ?? null;
    }

    private async buildSnapshot() {
      return buildAdminSnapshot({
        config: this.config,
        queue: await this.listQueue(),
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

    /** Mark admin snapshots dirty; flushed once at the end of the current handler. */
    private scheduleAdminBroadcast(): void {
      this.adminDirty = true;
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
      await this.releaseMember(connId, member, "server", { notify: true });
      await this.tryAdmitNext();
      this.scheduleAdminBroadcast();
      return { ok: true };
    }

    private async adminKickQueued(connId: string): Promise<{ ok: boolean; message?: string }> {
      const removed = await this.dequeue(connId);
      if (!removed) return { ok: false, message: "not_in_queue" };
      const conn = this.room.getConnection(connId);
      if (conn) {
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

      const members = [...slot.members];
      if (members.length === 0) {
        // Orphan slot (session but no members): release + drop the record.
        await this.runRelease({ sessionId, userId: "", reason: "server", lastMember: true });
        await this.deleteSlot(slot.slotId);
        this.config.hooks.onSessionClosed?.(sessionId, "server");
      } else {
        // Releasing members one by one ends the session on the last one.
        for (const connId of members) {
          const member = await this.getMember(connId);
          if (member) await this.releaseMember(connId, member, "server", { notify: true });
        }
      }

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
          if (!this.config.allowDuplicateConnections) {
            const entry = await this.getClientEntry(clientId);
            if (entry && entry.connId !== conn.id) {
              // The platform tracks connection liveness across hibernation, so
              // a live connection for this clientId means a real duplicate tab.
              // No app-level heartbeat needed; `onClose` cleans the mapping.
              if (this.room.getConnection(entry.connId)) {
                this.send(conn, { type: "rejected", reason: "already_connected" });
                conn.close(1008, "already_connected");
                return;
              }
              await this.room.storage.delete(`cid:${clientId}`);
              await this.room.storage.delete(`conn:${entry.connId}`);
            }
          }
          await this.setClientEntry(clientId, conn.id);
        }

        await this.enqueue(conn.id);
        this.config.hooks.onUserConnected?.(conn.id);
        await this.tryAdmitNext();
        this.scheduleAdminBroadcast();
        await this.flushBroadcasts();
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

        if (await this.dequeue(conn.id)) {
          this.scheduleBroadcast();
          this.scheduleAdminBroadcast();
        }

        const member = await this.getMember(conn.id);
        if (member) {
          await this.releaseMember(conn.id, member, "server", { notify: false });
          await this.tryAdmitNext();
        }

        this.config.hooks.onUserDisconnected?.(conn.id);
        await this.flushBroadcasts();
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
        await this.flushBroadcasts();
        return;
      }

      const msg = parseClientMessage(raw);
      if (!msg) return;

      try {
        switch (msg.type) {
          case "claim": {
            const member = await this.getMember(sender.id);
            if (member && !member.claimed && !member.claiming) {
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
              await this.releaseMember(sender.id, member, "server", { notify: false });
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
      await this.flushBroadcasts();
    }

    async onRequest(_req: Party.Request) {
      const queueLength = await this.getQueueCount();
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
            queueLength,
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
            // Session already ended on the platform; releasing each member empties
            // and deletes the slot. The default release's DELETE is a no-op (404).
            for (const connId of [...slot.members]) {
              const member = await this.getMember(connId);
              if (member) {
                await this.releaseMember(connId, member, "server", { notify: true });
              }
            }
            freedAny = true;
          } else {
            await this.setSlot({ ...slot, lastPollAt: now });
          }
        }

        if (freedAny) await this.tryAdmitNext();
        // Always refresh countdowns for waiting clients and admin dashboards.
        this.scheduleBroadcast();
        this.scheduleAdminBroadcast();
        await this.flushBroadcasts();
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
      let queueChanged = false;
      let admittedAny = false;
      let startAfter: string | undefined = undefined;

      // Walk the front of the queue in small FIFO batches. We only ever admit up
      // to the (small, GPU-bounded) remaining capacity, plus we skip any dead
      // front entries — so this touches O(admitted + stale) keys, not the whole
      // line. `frontQueue` reads individual keys, never one giant array.
      admit: while (true) {
        const batch = await this.frontQueue(20, startAfter);
        if (batch.length === 0) break;

        for (const [key, connId] of batch) {
          startAfter = key;

          const open = await this.findOpenSlot();
          const slotCount = await this.getSlotCount();
          // Reserve a seat in an open slot, or open a new slot if under the cap.
          if (!open && slotCount >= this.config.maxSessions) break admit;

          if (!this.room.getConnection(connId)) {
            // Dead/stale front entry — drop it.
            await this.dequeue(connId);
            queueChanged = true;
            continue;
          }

          const slot: SlotRecord = open ?? {
            slotId: this.genId(),
            sessionId: null,
            members: [],
            createdAt: Date.now(),
          };
          await this.setSlot({ ...slot, members: [...slot.members, connId] });

          await this.dequeue(connId);
          queueChanged = true;

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
          const conn = this.room.getConnection(connId);
          if (conn) await this.mintAndSend(conn);
          admittedAny = true;
        }
      }

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
      // Mark mid-claim *before* the first yield. `acquireSession` can be a slow
      // network call and the DO input gate is open across non-storage awaits, so
      // a duplicate `claim` could otherwise slip past the `!claimed` guard and
      // acquire a second session. This persisted flag closes that window; it is
      // cleared on completion or failure (and a stuck flag self-heals on grace
      // expiry, which still releases the member).
      await this.setMember(connId, { ...member, claiming: true });

      const slot = await this.getSlot(member.slotId);
      if (!slot) {
        // Slot vanished (e.g. reaped); nothing to claim.
        await this.setMember(connId, { ...member, claiming: false });
        return;
      }

      let sessionId = slot.sessionId;
      if (!sessionId) {
        try {
          sessionId = await this.runAcquire(this.config.model);
        } catch (err) {
          this.reportError("acquireSession", err);
          await this.setMember(connId, { ...member, claiming: false });
          this.sendTo(connId, { type: "error", message: "session_create_failed" });
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
        claiming: false,
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
     * Remove a member from its slot. If the slot has a session, fire the
     * `release` callback (a user left) with `lastMember`; the default deletes the
     * session when the last member leaves. When the slot empties, delete its
     * record and fire `onSessionClosed`. A slot whose session was never created
     * (abandoned grace) just disappears — no orphan, no release.
     */
    private async releaseMember(
      connId: string,
      data: MemberData,
      reason: "timeout" | "grace_timeout" | "server",
      opts: { notify: boolean }
    ): Promise<void> {
      if (opts.notify) {
        this.sendTo(connId, { type: "expired", reason });
      }

      const slot = await this.getSlot(data.slotId);
      if (slot) {
        const nextMembers = slot.members.filter((id) => id !== connId);
        const lastMember = nextMembers.length === 0;

        if (slot.sessionId) {
          await this.runRelease({
            sessionId: slot.sessionId,
            userId: connId,
            reason,
            lastMember,
          });
        }

        if (lastMember) {
          await this.deleteSlot(slot.slotId);
          if (slot.sessionId) this.config.hooks.onSessionClosed?.(slot.sessionId, reason);
          this.scheduleAdminBroadcast();
        } else {
          await this.setSlot({ ...slot, members: nextMembers });
        }
      }

      await this.deleteMember(connId);
    }

    // ── broadcasting (coalesced, hibernation-safe) ────────────────────────────

    /** Mark queue positions dirty; flushed once at the end of the current handler. */
    private scheduleBroadcast(): void {
      this.positionsDirty = true;
    }

    /**
     * Flush any pending broadcasts. Called at the end of every top-level handler
     * (onConnect/onClose/onMessage/onAlarm) so the work completes inside the
     * awaited handler turn — before PartyKit can hibernate the room. Multiple
     * `schedule*` calls within one handler collapse into a single broadcast.
     */
    private async flushBroadcasts(): Promise<void> {
      if (this.positionsDirty) {
        this.positionsDirty = false;
        try {
          await this.broadcastPositions();
        } catch (err) {
          this.reportError("broadcast", err);
        }
      }
      if (this.adminDirty) {
        this.adminDirty = false;
        try {
          await this.broadcastAdminSnapshots();
        } catch (err) {
          this.reportError("adminBroadcast", err);
        }
      }
    }

    private async broadcastPositions() {
      // Full FIFO scan — every waiter gets their exact position (no approximation).
      // O(N) iteration over individual keys; each send is an O(1) connection lookup.
      const queue = await this.listQueue();
      const total = queue.length;
      const activeCount = await this.getActiveMemberCount();
      for (let i = 0; i < queue.length; i++) {
        const connId = queue[i]!;
        this.sendTo(connId, {
          type: "queue_position",
          position: i + 1,
          total,
          active: activeCount,
          capacity: this.config.capacity,
        });
      }
    }
  };
}
