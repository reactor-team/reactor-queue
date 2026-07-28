import type * as Party from "partykit/server";
import {
  ADMIN_MODE_QUERY_KEY,
  CLIENT_ID_QUERY_KEY,
  parseAdminClientMessage,
  parseClientMessage,
  type AdminLogEntry,
  type AdminLogLevel,
  type AdminServerMessage,
  type ServerMessage,
} from "../protocol";
import { buildAdminSnapshot } from "./admin-snapshot";
import { resolveConfig, type ReactorQueueServerConfig, type ResolvedConfig } from "./config";
import type { ReleaseSessionContext } from "./config";
import { CoordinatorClient, CoordinatorError } from "./coordinator";

/** Max activity-log entries kept in the room's durable ring buffer. */
const MAX_LOG_ENTRIES = 200;

/** How many times a transient connection mint is retried before spilling to the next session. */
const CONNECTION_MINT_ATTEMPTS = 3;
/** Backoff between transient connection-mint retries, in ms. */
const CONNECTION_MINT_RETRY_MS = 250;

/**
 * Turn an arbitrary thrown value into a log-friendly message + structured data.
 * A {@link CoordinatorError} surfaces the endpoint, HTTP status, and (truncated)
 * response body — so an admin sees *why* the Reactor API said no (quota, expired
 * key, bad model, …) rather than an opaque failure.
 */
function describeError(error: unknown): { message: string; data?: Record<string, unknown> } {
  if (error instanceof CoordinatorError) {
    const body = error.body.length > 2000 ? `${error.body.slice(0, 2000)}…` : error.body;
    return {
      message: error.message,
      data: { endpoint: error.endpoint, status: error.status, body },
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      data: error.name && error.name !== "Error" ? { name: error.name } : undefined,
    };
  }
  return { message: String(error) };
}

/** Per admitted member. Lives in durable storage under `member:<connId>`. */
interface MemberData {
  /** The capacity slot this member occupies. */
  slotId: string;
  /** Reactor session id once the slot's session is created (on claim); null during grace. */
  sessionId: string | null;
  /** Server-minted WebRTC connection id once claimed; null during grace. */
  connectionId: number | null;
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
 * import { createReactorQueueServer } from "@reactor-team/queue/server";
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
    // Structured events produced during the current handler. Flushed (persisted
    // to the ring buffer + streamed to admins) once, alongside the broadcasts.
    private pendingLogs: AdminLogEntry[] = [];

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
          webrtcVersion: c.webrtcVersion,
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
     * Whether members get session-scoped tokens (the default). An
     * `acquireSession` override may return a session belonging to a principal
     * this server's API key cannot bind against, and the Coordinator refuses
     * such a mint, so those deployments keep unscoped member tokens.
     */
    private get scopedTokens(): boolean {
      return !this.config.acquireSession;
    }

    /**
     * Mint one member's own token for `sessionId`: confined to the configured
     * model and bound to that single session. Binding at mint is what lets a
     * member operate a session the server created for them, so members sharing
     * a slot hold distinct tokens rather than copies of one. The session limit
     * is left to resolve to the bound count, which makes the grant full on
     * arrival — the token drives the session it was given and can open none.
     */
    private mintMemberToken(sessionId: string): Promise<{ jwt: string; expiresAt: number }> {
      return this.api.mintToken(this.config.tokenTtlSeconds, {
        model: this.config.model,
        sessions: [sessionId],
      });
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

    /**
     * Log a non-fatal error as a structured `error` event (visible in the admin
     * activity log, with the API status/body for {@link CoordinatorError}) and
     * fire the `onError` hook. `where` doubles as the event code.
     */
    private reportError(
      where: string,
      error: unknown,
      opts: { connId?: string; sessionId?: string } = {}
    ) {
      const { message, data } = describeError(error);
      this.log("error", where, message, { ...opts, data });
      try {
        this.config.hooks.onError?.(where, error);
      } catch {
        /* hook must never throw the server over */
      }
    }

    /** Write a structured line to the server console, nothing else. */
    private writeConsole(
      level: AdminLogLevel,
      event: string,
      message: string,
      data?: Record<string, unknown>
    ): void {
      const line = `[reactor-queue] ${event}: ${message}`;
      const ctx = data ?? "";
      if (level === "error") console.error(line, ctx);
      else if (level === "warn") console.warn(line, ctx);
      else console.log(line, ctx);
    }

    /**
     * Record one structured server event. Always writes to the server console;
     * when admin mode is enabled (`adminPassword` set) it is also queued for the
     * admin stream. This is the single place server events become visible — call
     * it wherever something notable happens.
     *
     * Only console + in-memory work happens here; the persist/broadcast is
     * deferred to `flushBroadcasts()` so it lands inside the handler turn
     * (hibernation-safe) and coalesces with the queue/admin broadcasts. There,
     * `info` events are streamed to live admins only, while `warn`/`error` are
     * also written to the durable ring buffer — so the high-frequency hot path
     * (connects/disconnects) never touches storage, but failures stay in history.
     *
     * Do **not** use this for connection rejections (forbidden origin, duplicate
     * tab): those are unauthenticated and attacker-driven, so queuing them would
     * let a flood drive admin-stream work. Log rejections with `writeConsole`.
     */
    private log(
      level: AdminLogLevel,
      event: string,
      message: string,
      opts: { connId?: string; sessionId?: string; data?: Record<string, unknown> } = {}
    ): void {
      this.writeConsole(level, event, message, opts.data);

      // Only pay the stream/storage cost when an operator can actually read it.
      if (!this.config.adminPassword) return;
      this.pendingLogs.push({
        id: this.genId(),
        at: Date.now(),
        level,
        event,
        message,
        ...(opts.connId ? { connId: opts.connId } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.data ? { data: opts.data } : {}),
      });
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

    /** The slot currently listing `connId` as a member, or undefined. */
    private async findSlotByMember(connId: string): Promise<SlotRecord | undefined> {
      for (const [, slot] of await this.getAllSlots()) {
        if (slot.members.includes(connId)) return slot;
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

    private async broadcastAdminSnapshots(admins: string[]): Promise<void> {
      if (admins.length === 0) return;
      const snapshot = await this.buildSnapshot();
      for (const connId of admins) this.sendAdminTo(connId, snapshot);
    }

    // ── activity log: bounded ring buffer + live admin stream ────────────────
    // One key per entry (`log:<padded seq>`) with `logseq` (next) and `logmin`
    // (oldest) counters, mirroring the queue's storage model: appends are O(1),
    // history survives hibernation, and the buffer self-trims to MAX_LOG_ENTRIES.

    private logKey(seq: number): string {
      return `log:${String(seq).padStart(16, "0")}`;
    }

    /** Append entries to the durable ring buffer, trimming the oldest past the cap. */
    private async persistLogs(entries: AdminLogEntry[]): Promise<void> {
      let seq = (await this.room.storage.get<number>("logseq")) ?? 0;
      let min = (await this.room.storage.get<number>("logmin")) ?? 0;
      for (const entry of entries) {
        await this.room.storage.put(this.logKey(seq), entry);
        seq++;
      }
      await this.room.storage.put("logseq", seq);
      while (seq - min > MAX_LOG_ENTRIES) {
        await this.room.storage.delete(this.logKey(min));
        min++;
      }
      await this.room.storage.put("logmin", min);
    }

    /** Recent log entries in chronological order (oldest → newest). */
    private async listLogHistory(): Promise<AdminLogEntry[]> {
      const items = await this.room.storage.list<AdminLogEntry>({ prefix: "log:" });
      return [...items.values()];
    }

    private broadcastLogs(admins: string[], entries: AdminLogEntry[]): void {
      for (const connId of admins) {
        for (const entry of entries) this.sendAdminTo(connId, { type: "admin_log", entry });
      }
    }

    private async adminKickMember(connId: string): Promise<{ ok: boolean; message?: string }> {
      const member = await this.getMember(connId);
      if (member) {
        await this.releaseMember(connId, member, "server", { notify: true });
        await this.tryAdmitNext();
        this.log("warn", "admin_kick_member", "Admin evicted an admitted member", {
          connId,
          sessionId: member.sessionId ?? undefined,
        });
        this.scheduleAdminBroadcast();
        return { ok: true };
      }

      // No member record, but the connId may be a *stale* entry left in a slot by
      // a release/poll race. Scrub it (dropping the slot if it empties) so an
      // operator can always clear an orphan the normal eviction can't reach.
      const slot = await this.findSlotByMember(connId);
      if (!slot) return { ok: false, message: "member_not_found" };

      const live = slot.members.filter((id) => id !== connId);
      if (live.length === 0) {
        await this.dropSlot(slot.slotId, "server", { notify: false });
      } else {
        await this.setSlot({ ...slot, members: live });
      }
      await this.tryAdmitNext();
      this.log("warn", "admin_kick_member", "Admin cleared a stale member from a slot", {
        connId,
        sessionId: slot.sessionId ?? undefined,
      });
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
      this.log("warn", "admin_kick_queued", "Admin removed a waiting user from the queue", {
        connId,
      });
      this.scheduleBroadcast();
      this.scheduleAdminBroadcast();
      return { ok: true };
    }

    private async adminCloseSession(sessionId: string): Promise<{ ok: boolean; message?: string }> {
      const slot = await this.findSlotBySessionId(sessionId);
      if (!slot) return { ok: false, message: "session_not_found" };

      // Release members that still have records so a custom `releaseSession` sees
      // each departing user; the last one tears the slot down normally.
      for (const connId of [...slot.members]) {
        const member = await this.getMember(connId);
        if (member) await this.releaseMember(connId, member, "server", { notify: true });
      }
      // If the slot survived — its listed members had no records (an orphan) —
      // force it closed so "Close session" always actually closes the session.
      await this.dropSlot(slot.slotId, "server", { notify: true });

      await this.tryAdmitNext();
      this.log("warn", "admin_close_session", "Admin force-closed a session", { sessionId });
      this.scheduleAdminBroadcast();
      return { ok: true };
    }

    // ── connection lifecycle ────────────────────────────────────────────────

    /**
     * Enforce the configured cross-origin allow-list. Empty list = allow all
     * (opt-in). A `"*"` entry allows everything, including connections with no
     * `Origin` header. Otherwise the browser's `Origin` must match exactly.
     */
    private isOriginAllowed(origin: string | null): boolean {
      const allowed = this.config.allowedOrigins;
      if (allowed.length === 0 || allowed.includes("*")) return true;
      return origin !== null && allowed.includes(origin);
    }

    async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
      try {
        const url = new URL(ctx.request.url);
        const isAdmin = url.searchParams.get(ADMIN_MODE_QUERY_KEY) === "1";

        if (!this.isOriginAllowed(ctx.request.headers.get("origin"))) {
          if (isAdmin) {
            this.sendAdmin(conn, { type: "admin_rejected", reason: "forbidden_origin" });
          } else {
            this.send(conn, { type: "rejected", reason: "forbidden_origin" });
          }
          // Console-only: an unauthenticated origin flood must not be able to
          // drive admin-stream/storage work — that would amplify the very abuse
          // the allow-list exists to reject cheaply.
          this.writeConsole(
            "warn",
            "forbidden_origin",
            "Rejected a connection from a disallowed origin",
            {
              origin: ctx.request.headers.get("origin") ?? null,
              admin: isAdmin,
            }
          );
          conn.close(1008, "forbidden_origin");
          return;
        }

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
                // Console-only (same reasoning as forbidden_origin): a rejection
                // path must stay cheap and not feed the admin stream/storage.
                this.writeConsole(
                  "warn",
                  "duplicate_rejected",
                  "Rejected a duplicate connection (same browser already connected in another tab)",
                  { connId: conn.id }
                );
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
        this.log("info", "user_connected", "User connected and joined the queue", {
          connId: conn.id,
        });
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
        this.log("info", "user_disconnected", "User connection closed", { connId: conn.id });
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
            this.sendAdmin(sender, {
              type: "admin_log_history",
              entries: await this.listLogHistory(),
            });
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
            if (member) await this.sendMemberToken(sender);
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

    // ── alarm: warnings, expiry, and session reconciliation ──────────────────

    async onAlarm() {
      try {
        const members = await this.getAllMembers();
        const now = Date.now();
        let freedAny = false;

        for (const [key, data] of members) {
          const connId = key.replace("member:", "");

          // Liveness reconcile: if the member's PartyKit WS is gone but `onClose`
          // never fired, release them so the slot seat frees and (on the last
          // member) the server stops the session. The platform already reaped
          // this member's WebRTC connection on its side. Skip members mid-claim —
          // that network round-trip completes or grace-expires on its own.
          if (!data.claiming && !this.room.getConnection(connId)) {
            await this.releaseMember(connId, data, "server", { notify: false });
            freedAny = true;
            continue;
          }

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

        // Prune orphaned slots (stale members, no member records) before polling,
        // so the platform isn't queried for slots that are about to be freed.
        if (await this.reconcileSlots()) freedAny = true;

        for (const [, slot] of await this.getAllSlots()) {
          // Only poll slots whose Reactor session actually exists.
          if (!slot.sessionId || slot.members.length === 0) continue;
          if (now - (slot.lastPollAt ?? 0) < this.config.pollIntervalMs) continue;

          const state = await this.api.getSessionState(slot.sessionId);
          if (CoordinatorClient.isTerminal(state)) {
            // Session already ended on the platform; releasing each member empties
            // and deletes the slot. The default release's DELETE is a no-op (404).
            this.log("info", "session_reaped", "Session ended on the platform; freeing the slot", {
              sessionId: slot.sessionId,
              data: { state },
            });
            for (const connId of [...slot.members]) {
              const member = await this.getMember(connId);
              if (member) {
                await this.releaseMember(connId, member, "server", { notify: true });
              }
            }
            // Force-drop if the slot is orphaned (listed members had no records),
            // so a terminal session can never wedge a slot forever.
            await this.dropSlot(slot.slotId, "server", { notify: true });
            freedAny = true;
          } else {
            // Re-read before writing: `getSessionState` opened the input gate, so
            // the slot may have just been deleted. Never re-persist a stale copy.
            const fresh = await this.getSlot(slot.slotId);
            if (fresh) await this.setSlot({ ...fresh, lastPollAt: now });
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
            connectionId: null,
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
          this.log(
            "info",
            "user_admitted",
            "User reached the front and was admitted (slot reserved, no session yet)",
            {
              connId,
            }
          );
          // A member seated on a slot that is already running can be handed a
          // token now; one holding a freshly reserved slot has no session to
          // bind against yet and receives theirs at claim.
          const conn = this.room.getConnection(connId);
          if (conn) await this.sendMemberToken(conn);
          admittedAny = true;
        }
      }

      if (admittedAny) await this.scheduleNextAlarm();
      this.scheduleBroadcast();
      if (queueChanged || admittedAny) this.scheduleAdminBroadcast();
    }

    /**
     * The member confirmed entry. Seat them on a session that accepts a freshly
     * minted WebRTC connection (their own slot's, an existing one with room, or a
     * new one), start the full session timer, and hand back the `sessionId` +
     * server-minted `connectionId` to attach with. The server owns both, so the
     * client only adopts — it never creates or stops anything.
     */
    private async claimMember(connId: string, member: MemberData): Promise<void> {
      // Mark mid-claim *before* the first yield. Acquiring a session and minting
      // a connection are network calls and the DO input gate is open across them,
      // so a duplicate `claim` could otherwise slip past the `!claimed` guard.
      // This persisted flag closes that window; it is cleared on completion or
      // failure (a stuck flag self-heals on grace expiry, which still releases
      // the member).
      await this.setMember(connId, { ...member, claiming: true });

      const placement = await this.placeMemberWithConnection(connId, member);
      if (!placement) {
        // No session could take the member (all at their connection cap, or
        // session creation failed). The admin log already carries the
        // Coordinator status/body from the failing call.
        await this.setMember(connId, { ...member, claiming: false });
        this.sendTo(connId, { type: "error", message: "no_capacity" });
        return;
      }

      const { slotId, sessionId, connectionId } = placement;
      const expiresAt = Date.now() + this.config.sessionDurationMs;
      await this.setMember(connId, {
        ...member,
        slotId,
        sessionId,
        connectionId,
        expiresAt,
        warned: false,
        claimed: true,
        claiming: false,
      });

      // A member's token binds to exactly one session and the claim is what
      // decides which — their own slot, a shared slot with room, or a fresh
      // one — so it can only be minted here. Sent before session_ready so the
      // SDK holds it the moment it is told what to attach to.
      const conn = this.room.getConnection(connId);
      if (conn) await this.sendMemberToken(conn);

      this.sendTo(connId, {
        type: "session_ready",
        sessionId,
        connectionId,
        sessionDurationMs: this.config.sessionDurationMs,
        expiresAt,
      });
      this.config.hooks.onUserEnteredSession?.(connId, sessionId);
      this.log("info", "session_ready", "User claimed and entered the session", {
        connId,
        sessionId,
        data: { connectionId },
      });
      await this.scheduleNextAlarm();
      this.scheduleAdminBroadcast();
    }

    /**
     * Seat a claiming member on a slot whose Reactor session accepts a freshly
     * minted WebRTC connection, returning that placement. Tries the member's own
     * slot first, then any other slot with a free seat, then a brand-new slot
     * (bounded by `maxSessions`). The connection mint is the real capacity test:
     * a 429 means the session hit its `connections_per_session` cap, so we spill
     * to the next candidate; transient mint errors retry on the same session.
     * Returns null when nothing could take the member.
     */
    private async placeMemberWithConnection(
      connId: string,
      member: MemberData
    ): Promise<{ slotId: string; sessionId: string; connectionId: number } | null> {
      const candidates: string[] = [member.slotId];
      for (const [, slot] of await this.getAllSlots()) {
        if (slot.slotId !== member.slotId && slot.members.length < this.config.usersPerSession) {
          candidates.push(slot.slotId);
        }
      }

      for (const slotId of candidates) {
        const minted = await this.mintConnectionOnSlot(connId, slotId);
        if (minted) {
          await this.assignMemberToSlot(connId, member.slotId, slotId);
          return { slotId, ...minted };
        }
      }

      // No existing session could take the member — open a new slot if under the cap.
      if ((await this.getSlotCount()) < this.config.maxSessions) {
        const newSlot: SlotRecord = {
          slotId: this.genId(),
          sessionId: null,
          members: [],
          createdAt: Date.now(),
        };
        await this.setSlot(newSlot);
        const minted = await this.mintConnectionOnSlot(connId, newSlot.slotId);
        if (minted) {
          await this.assignMemberToSlot(connId, member.slotId, newSlot.slotId);
          return { slotId: newSlot.slotId, ...minted };
        }
        // The fresh slot couldn't take a connection either — drop it + its session.
        await this.dropSlot(newSlot.slotId, "server", { notify: false });
      }

      return null;
    }

    /**
     * Ensure the slot has a Reactor session (creating one if needed) and mint a
     * WebRTC connection under it, retrying transient failures. Returns the
     * session + connection id on success, or null if the session is at its
     * connection cap, if creation failed, or if the slot vanished — the caller
     * spills to the next candidate. Writes re-read after each network await (the
     * input gate is open across them) so a concurrent handler isn't clobbered.
     */
    private async mintConnectionOnSlot(
      connId: string,
      slotId: string
    ): Promise<{ sessionId: string; connectionId: number } | null> {
      const slot = await this.getSlot(slotId);
      if (!slot) return null;

      let sessionId = slot.sessionId;
      if (!sessionId) {
        try {
          sessionId = await this.runAcquire(this.config.model);
        } catch (err) {
          this.reportError("session_create_failed", err, { connId });
          return null;
        }
        const fresh = await this.getSlot(slotId);
        if (!fresh) return null;
        await this.setSlot({ ...fresh, sessionId });
        this.config.hooks.onSessionCreated?.(sessionId);
        this.log("info", "session_created", "Created a new Reactor session", { connId, sessionId });
      }

      for (let attempt = 1; attempt <= CONNECTION_MINT_ATTEMPTS; attempt++) {
        try {
          const connectionId = await this.api.createConnection(sessionId);
          return { sessionId, connectionId };
        } catch (err) {
          if (err instanceof CoordinatorError && err.status === 429) {
            this.log("info", "connection_cap_reached", "Session at its connection cap; spilling", {
              connId,
              sessionId,
            });
            return null;
          }
          if (attempt === CONNECTION_MINT_ATTEMPTS) {
            this.reportError("connection_mint_failed", err, { connId, sessionId });
            return null;
          }
          await this.sleep(CONNECTION_MINT_RETRY_MS);
        }
      }
      return null;
    }

    /**
     * Move a member's slot membership from `fromSlotId` to `toSlotId` (no-op when
     * they are the same). The member is removed from the source first; if that
     * empties the source, its session is released and the slot dropped, so a
     * session created for a member who then spilled elsewhere never lingers.
     */
    private async assignMemberToSlot(
      connId: string,
      fromSlotId: string,
      toSlotId: string
    ): Promise<void> {
      if (fromSlotId === toSlotId) return;

      const to = await this.getSlot(toSlotId);
      if (to && !to.members.includes(connId)) {
        await this.setSlot({ ...to, members: [...to.members, connId] });
      }

      const from = await this.getSlot(fromSlotId);
      if (!from) return;
      const remaining = from.members.filter((id) => id !== connId);
      if (remaining.length > 0) {
        await this.setSlot({ ...from, members: remaining });
        return;
      }

      // Source emptied by the move: release its session (if any) and drop it.
      if (from.sessionId) {
        await this.runRelease({
          sessionId: from.sessionId,
          userId: connId,
          reason: "server",
          lastMember: true,
        });
        this.config.hooks.onSessionClosed?.(from.sessionId, "server");
      }
      // Re-read after the network release before deleting (gate was open).
      const recheck = await this.getSlot(fromSlotId);
      if (recheck && recheck.members.filter((id) => id !== connId).length === 0) {
        await this.deleteSlot(fromSlotId);
        this.scheduleAdminBroadcast();
      }
    }

    private sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Send a member a token for the session their slot holds. In scoped mode a
     * member still in the admission grace has no session to bind to yet and is
     * answered at claim instead; the SDK has nothing to attach to until then,
     * and its `getJwt` resolver re-asks over `request_token` when it does.
     */
    private async sendMemberToken(conn: Party.Connection): Promise<void> {
      try {
        if (this.scopedTokens) {
          const member = await this.getMember(conn.id);
          if (!member) return;
          const slot = await this.getSlot(member.slotId);
          if (!slot?.sessionId) return;
          const token = await this.mintMemberToken(slot.sessionId);
          this.send(conn, { type: "token", jwt: token.jwt, expiresAt: token.expiresAt });
          return;
        }
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

      if (reason === "timeout") {
        this.log("info", "session_timeout", "Session time elapsed; reclaiming the slot", {
          connId,
          sessionId: data.sessionId ?? undefined,
        });
      } else if (reason === "grace_timeout") {
        this.log("info", "grace_timeout", "Admitted user did not claim in time; slot reclaimed", {
          connId,
        });
      }

      const slot = await this.getSlot(data.slotId);
      if (slot) {
        const lastMember = slot.members.filter((id) => id !== connId).length === 0;

        if (slot.sessionId) {
          await this.runRelease({
            sessionId: slot.sessionId,
            userId: connId,
            reason,
            lastMember,
          });
        }

        // Re-read after `runRelease`: the input gate is open across that network
        // call, so a concurrent handler may have mutated or deleted this slot.
        // Writing back the pre-call snapshot is what resurrects a just-deleted
        // slot into an orphan (members listed, member record gone), so apply the
        // removal to the *current* record — or skip entirely if it's already gone.
        const fresh = await this.getSlot(data.slotId);
        if (fresh) {
          const nextMembers = fresh.members.filter((id) => id !== connId);
          if (nextMembers.length === 0) {
            await this.deleteSlot(fresh.slotId);
            if (fresh.sessionId) {
              this.config.hooks.onSessionClosed?.(fresh.sessionId, reason);
              this.log("info", "session_closed", "Reactor session closed (last member left)", {
                sessionId: fresh.sessionId,
                data: { reason },
              });
            }
            this.scheduleAdminBroadcast();
          } else {
            await this.setSlot({ ...fresh, members: nextMembers });
          }
        }
      }

      await this.deleteMember(connId);
    }

    /**
     * Tear a slot down directly, independent of whether its member records still
     * exist. Releases the Reactor session (if any), drops any member records the
     * slot still lists, and deletes the slot. This is the recovery path for an
     * *orphaned* slot — one listing members whose `member:` records were already
     * deleted by a concurrent release — which `releaseMember` can never reach
     * because it keys off the member record. Safe to call on an already-gone slot.
     *
     * Storage is torn down first (no network in between, so it lands atomically
     * w.r.t. other handlers); the best-effort session release runs afterwards,
     * once internal state is already consistent.
     */
    private async dropSlot(
      slotId: string,
      reason: "timeout" | "grace_timeout" | "server",
      opts: { notify: boolean }
    ): Promise<void> {
      const slot = await this.getSlot(slotId);
      if (!slot) return;

      for (const connId of slot.members) {
        if (opts.notify) this.sendTo(connId, { type: "expired", reason });
        await this.deleteMember(connId);
      }
      await this.deleteSlot(slot.slotId);
      this.scheduleAdminBroadcast();

      if (slot.sessionId) {
        await this.runRelease({ sessionId: slot.sessionId, userId: "", reason, lastMember: true });
        this.config.hooks.onSessionClosed?.(slot.sessionId, reason);
        this.log("info", "session_closed", "Reactor session closed (slot dropped)", {
          sessionId: slot.sessionId,
          data: { reason },
        });
      }
    }

    /**
     * Self-heal slot/member drift. A release spans the `DELETE /sessions` network
     * call with the input gate open, so it can interleave with a concurrent slot
     * write and leave a slot referencing a connId whose `member:` record is gone
     * — an orphan no normal path reaps (the reap and admin close both key off the
     * member record). Prune stale connIds from every slot; if that empties a
     * slot, drop it (releasing its Reactor session). Returns true if it freed a
     * slot, so the caller can re-run admission.
     */
    private async reconcileSlots(): Promise<boolean> {
      let freed = false;
      for (const [slotKey] of await this.getAllSlots()) {
        const slotId = slotKey.replace("slot:", "");
        const slot = await this.getSlot(slotId);
        if (!slot) continue;

        const live: string[] = [];
        for (const connId of slot.members) {
          if (await this.getMember(connId)) live.push(connId);
        }
        if (live.length === slot.members.length) continue;

        if (live.length === 0) {
          this.log("warn", "slot_reconciled", "Dropped an orphaned slot (no live members)", {
            sessionId: slot.sessionId ?? undefined,
            data: { staleMembers: slot.members.length },
          });
          await this.dropSlot(slot.slotId, "server", { notify: false });
          freed = true;
        } else {
          this.log("warn", "slot_reconciled", "Pruned stale members from a slot", {
            sessionId: slot.sessionId ?? undefined,
            data: { before: slot.members.length, after: live.length },
          });
          await this.setSlot({ ...slot, members: live });
        }
      }
      return freed;
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
      const haveLogs = this.pendingLogs.length > 0;
      if (this.adminDirty || haveLogs) {
        // Resolve the active admin set once: the snapshot push and the log stream
        // both target it, so we don't scan `admin:` twice per flush.
        const admins = await this.getActiveAdminConnIds();

        if (this.adminDirty) {
          this.adminDirty = false;
          try {
            await this.broadcastAdminSnapshots(admins);
          } catch (err) {
            this.reportError("adminBroadcast", err);
          }
        }

        if (haveLogs) {
          const batch = this.pendingLogs;
          this.pendingLogs = [];
          try {
            // Persist only warn/error — the rare, diagnostic history (kept even
            // with no admin watching, so it's there when one connects). `info`
            // is streamed to live admins but never written to storage, so the
            // high-frequency connect/disconnect hot path stays storage-free.
            const durable = batch.filter((e) => e.level !== "info");
            if (durable.length > 0) await this.persistLogs(durable);
            this.broadcastLogs(admins, batch);
          } catch (err) {
            // Never route through reportError → log() (would re-enqueue and recurse).
            console.error("[reactor-queue] logFlush", err);
          }
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
