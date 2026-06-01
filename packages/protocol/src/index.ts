/**
 * Shared wire protocol for `@reactor-team/queue`.
 *
 * Both the PartyKit server (`@reactor-team/queue-server`) and the browser
 * client (`@reactor-team/queue`) import these types so the messages they
 * exchange over the WebSocket stay in lockstep. Nothing here depends on
 * PartyKit, the Reactor SDK, React, or the DOM — it is plain data.
 */

/** Current protocol version. Bumped only on breaking wire changes. */
export const PROTOCOL_VERSION = 1 as const;

/** Default PartyKit room id. A single room is the source of truth for one queue. */
export const DEFAULT_ROOM = "reactor-queue";

/** Query-string key used to carry the stable per-browser id on connect. */
export const CLIENT_ID_QUERY_KEY = "rqClientId";

/** Set to `1` on the WebSocket URL to open an admin connection (not queued). */
export const ADMIN_MODE_QUERY_KEY = "rqAdmin";

/**
 * Default tunables. Every one of these is overridable from server config and/or
 * environment variables (see `@reactor-team/queue-server`).
 */
export const DEFAULTS = {
  /** Max concurrent Reactor sessions (GPU ceiling). */
  maxSessions: 1,
  /** Members per session (default 1 = today's behavior; >1 when platform allows N). */
  usersPerSession: 1,
  /** Full session budget once a user has `claim()`ed their slot. */
  sessionDurationMs: 120_000,
  /**
   * Grace window an admitted user gets to actually start (claim) their session
   * before the slot is reclaimed. Prevents an idle admit from wasting a slot.
   */
  admissionGraceMs: 45_000,
  /** How long before expiry to emit a `time_warning`. */
  warningBeforeMs: 30_000,
  /** Lifetime requested for each minted Reactor JWT. Deliberately short. */
  tokenTtlSeconds: 60,
  /** A connection whose heartbeat is older than this is considered dead. */
  heartbeatStaleMs: 15_000,
  /** Client heartbeat cadence. Must be < heartbeatStaleMs. */
  heartbeatIntervalMs: 5_000,
  /**
   * How often the server re-checks tracked live sessions against the Reactor
   * API to catch sessions that ended without a clean `session_ended`/close.
   */
  pollIntervalMs: 15_000,
  /** Client-side skew: refresh the JWT this long before it actually expires. */
  tokenSkewMs: 10_000,
} as const;

/** Reactor session states that mean "the slot is free again". */
export const TERMINAL_SESSION_STATES = ["CLOSED", "INACTIVE"] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Server → Client messages
// ─────────────────────────────────────────────────────────────────────────────

/** You are waiting in line. `position` is 1-based. */
export interface QueuePositionMessage {
  type: "queue_position";
  position: number;
  total: number;
  active: number;
  capacity: number;
}

/**
 * You reached the front and a capacity slot is reserved for you. No Reactor
 * session exists yet — the server creates it only when you `claim()`, so an
 * abandoned grace never leaves an orphaned GPU session. You have until the
 * admission grace expires to `claim()`.
 */
export interface AdmittedMessage {
  type: "admitted";
  active: number;
  /** Total live users = maxSessions * usersPerSession. */
  capacity: number;
  /** ms the client has to `claim()` before the slot is reclaimed. */
  graceMs: number;
  /** Full session budget (ms) the client receives once it `claim()`s. For countdown UI. */
  sessionDurationMs: number;
}

/**
 * Sent after `claim()`: the server has created (or reused) the Reactor session
 * for this member. Attach with `connect({ sessionId })`.
 */
export interface SessionReadyMessage {
  type: "session_ready";
  /** Reactor session id created by the server — attach with connect({ sessionId }). */
  sessionId: string;
  /** Full session budget (ms). */
  sessionDurationMs: number;
  /** Unix epoch ms when the session ends. */
  expiresAt: number;
}

/** A freshly minted, short-lived Reactor JWT. Sent on admission and on each `request_token`. */
export interface TokenMessage {
  type: "token";
  jwt: string;
  /** Unix epoch seconds at which the JWT expires. */
  expiresAt: number;
}

/** Your session is about to end. */
export interface TimeWarningMessage {
  type: "time_warning";
  secondsLeft: number;
  /** Unix epoch ms when the session ends. */
  expiresAt: number;
}

/** Your session ended (time ran out, or the server reclaimed the slot). */
export interface ExpiredMessage {
  type: "expired";
  reason: "timeout" | "grace_timeout" | "server";
}

/** You were refused entry. */
export interface RejectedMessage {
  type: "rejected";
  reason: "already_connected" | "server_error" | string;
}

/** A non-fatal error (e.g. token mint failed); the client may retry. */
export interface ErrorMessage {
  type: "error";
  message: string;
}

export type ServerMessage =
  | QueuePositionMessage
  | AdmittedMessage
  | SessionReadyMessage
  | TokenMessage
  | TimeWarningMessage
  | ExpiredMessage
  | RejectedMessage
  | ErrorMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Client → Server messages
// ─────────────────────────────────────────────────────────────────────────────

/** Keep-alive so the server can evict stale connections. */
export interface HeartbeatMessage {
  type: "heartbeat";
}

/** "I'm actually entering the demo" — upgrades the grace window to the full session. */
export interface ClaimMessage {
  type: "claim";
}

/** Ask for a fresh JWT. The server only answers if you currently hold a slot. */
export interface RequestTokenMessage {
  type: "request_token";
}

/** The user ended the Reactor session from the client; free the slot now. */
export interface SessionEndedMessage {
  type: "session_ended";
}

/** Leave the queue / release the slot without intending to rejoin. */
export interface LeaveMessage {
  type: "leave";
}

export type ClientMessage =
  | HeartbeatMessage
  | ClaimMessage
  | RequestTokenMessage
  | SessionEndedMessage
  | LeaveMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Admin mode (server → admin client)
// ─────────────────────────────────────────────────────────────────────────────

/** Read-only server tunables included in every admin snapshot. */
export interface AdminConfigSnapshot {
  maxSessions: number;
  usersPerSession: number;
  capacity: number;
  model: string;
  webrtcVersion: string;
  sessionDurationMs: number;
  admissionGraceMs: number;
  warningBeforeMs: number;
  tokenTtlSeconds: number;
  heartbeatStaleMs: number;
  pollIntervalMs: number;
  coordinatorUrl: string;
  apiVersion: number;
  stopSessionsOnExpiry: boolean;
}

/** One person waiting in the FIFO queue. */
export interface AdminQueuedUserSnapshot {
  connId: string;
  /** 1-based position in line. */
  position: number;
  clientId: string | null;
}

/** One admitted member (may or may not have claimed yet). */
export interface AdminMemberSnapshot {
  connId: string;
  /** Reactor session id once claimed; null while still in grace (no session yet). */
  sessionId: string | null;
  clientId: string | null;
  claimed: boolean;
  expiresAt: number;
  msLeft: number;
}

/** One capacity slot and its member connection ids. */
export interface AdminSessionSnapshot {
  /** Reactor session id, or null while the slot is reserved but unclaimed (no GPU session yet). */
  sessionId: string | null;
  members: string[];
  createdAt: number;
  msSinceCreated: number;
}

/** Full room state pushed to authenticated admin connections. */
export interface AdminSnapshotMessage {
  type: "admin_snapshot";
  at: number;
  activeCount: number;
  sessionCount: number;
  config: AdminConfigSnapshot;
  queue: AdminQueuedUserSnapshot[];
  sessions: AdminSessionSnapshot[];
  members: AdminMemberSnapshot[];
}

/** Admin WebSocket authenticated; snapshots follow on changes. */
export interface AdminReadyMessage {
  type: "admin_ready";
}

export interface AdminRejectedMessage {
  type: "admin_rejected";
  reason: "admin_disabled" | "invalid_password" | "auth_required";
}

export interface AdminActionResultMessage {
  type: "admin_action_result";
  action: "kick_member" | "kick_queued" | "close_session";
  ok: boolean;
  message?: string;
}

export type AdminServerMessage =
  | AdminReadyMessage
  | AdminRejectedMessage
  | AdminSnapshotMessage
  | AdminActionResultMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Admin mode (admin client → server)
// ─────────────────────────────────────────────────────────────────────────────

/** First message on an admin connection; password must match `RQ_ADMIN_PASSWORD`. */
export interface AdminAuthMessage {
  type: "admin_auth";
  password: string;
}

/** Remove a member from their session and free capacity (same as forced expiry). */
export interface AdminKickMemberMessage {
  type: "admin_kick_member";
  connId: string;
}

/** Drop a still-waiting connection from the queue and close its socket. */
export interface AdminKickQueuedMessage {
  type: "admin_kick_queued";
  connId: string;
}

/** Stop the Reactor session and evict all members. */
export interface AdminCloseSessionMessage {
  type: "admin_close_session";
  sessionId: string;
}

/** Request a fresh snapshot (also sent automatically on room changes). */
export interface AdminRefreshMessage {
  type: "admin_refresh";
}

export type AdminClientMessage =
  | AdminAuthMessage
  | AdminKickMemberMessage
  | AdminKickQueuedMessage
  | AdminCloseSessionMessage
  | AdminRefreshMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Narrowing parse for an inbound server message. Returns null on garbage. */
export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const msg = JSON.parse(raw) as ServerMessage;
    return typeof msg?.type === "string" ? msg : null;
  } catch {
    return null;
  }
}

/** Narrowing parse for an inbound client message. Returns null on garbage. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;
    if (typeof msg?.type !== "string") return null;
    if (msg.type.startsWith("admin_")) return null;
    return msg;
  } catch {
    return null;
  }
}

/** Parse an admin client message. Returns null on garbage or non-admin types. */
export function parseAdminClientMessage(raw: string): AdminClientMessage | null {
  try {
    const msg = JSON.parse(raw) as AdminClientMessage;
    if (typeof msg?.type !== "string" || !msg.type.startsWith("admin_")) return null;
    return msg;
  } catch {
    return null;
  }
}

/** Parse a server message sent to an admin connection. */
export function parseAdminServerMessage(raw: string): AdminServerMessage | null {
  try {
    const msg = JSON.parse(raw) as AdminServerMessage;
    if (typeof msg?.type !== "string" || !msg.type.startsWith("admin_")) return null;
    return msg;
  } catch {
    return null;
  }
}
