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
 * You reached the front and a slot is reserved for you. A `token` message
 * follows immediately. You now have until the admission grace expires to
 * `claim()`.
 */
export interface AdmittedMessage {
  type: "admitted";
  active: number;
  /** Total live users = activeSessions * usersPerSession. */
  capacity: number;
  /** ms the client has to `claim()` before the slot is reclaimed. */
  graceMs: number;
  /** Full session budget (ms) the client receives once it `claim()`s. For countdown UI. */
  sessionDurationMs: number;
  /** Reactor session id created by the server — attach with connect({ sessionId }). */
  sessionId: string;
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
    return typeof msg?.type === "string" ? msg : null;
  } catch {
    return null;
  }
}
