/** Where the user is in the queue lifecycle. */
export type QueuePhase =
  /** Not connected and not trying to. */
  | "idle"
  /** Socket opening / waiting for the first server message. */
  | "connecting"
  /** In line, not yet at the front. */
  | "queued"
  /** At the front, capacity slot reserved — call `claim()` to enter. No session yet. */
  | "admitted"
  /** Claimed; waiting for the server to create the session and send `session_ready`. */
  | "starting"
  /** Session is ready (`sessionId` set); attach with the SDK. */
  | "active"
  /** Time ran out or the slot was reclaimed by the server. */
  | "expired"
  /** Refused entry (e.g. duplicate tab). */
  | "rejected"
  /** Socket closed without reaching a terminal phase. */
  | "disconnected";

/** Immutable snapshot of the queue client. Re-emitted on every change. */
export interface QueueState {
  phase: QueuePhase;
  /** 1-based position in line; 0 when not queued. */
  position: number;
  /** Total people in line. */
  total: number;
  /** Sessions currently active across all users. */
  active: number;
  /** Total live users the server allows (maxSessions × usersPerSession). */
  capacity: number;
  /** Current short-lived Reactor JWT, or null. */
  token: string | null;
  /** Unix epoch seconds at which `token` expires. */
  tokenExpiresAt: number | null;
  /** Unix epoch ms at which the user's session ends (known after admit/claim). */
  sessionEndsAt: number | null;
  /** Full session budget (ms) the slot grants after claim; null until admitted. */
  sessionDurationMs: number | null;
  /** Seconds left as of the last `time_warning`, else null. */
  secondsLeft: number | null;
  /** Reactor session id from the server (set on `session_ready`). */
  sessionId: string | null;
  /** Server-minted WebRTC connection id (set on `session_ready`); pass with sessionId. */
  connectionId: number | null;
  /** Reason for the most recent rejection/expiry/error, if any. */
  reason: string | null;
}

export const INITIAL_STATE: QueueState = {
  phase: "idle",
  position: 0,
  total: 0,
  active: 0,
  capacity: 0,
  token: null,
  tokenExpiresAt: null,
  sessionEndsAt: null,
  sessionDurationMs: null,
  secondsLeft: null,
  sessionId: null,
  connectionId: null,
  reason: null,
};

export interface ReactorQueueClientOptions {
  /** PartyKit host, e.g. `my-app.username.partykit.dev` or `127.0.0.1:1999` for dev. */
  host: string;
  /** Room id. Must match the server. Defaults to the protocol default room. */
  room?: string;
  /** PartyKit party (server binding) name. Defaults to `"main"`. */
  party?: string;
  /** Stable per-browser id; auto-generated + persisted in localStorage if omitted. */
  clientId?: string;
  /** Connect immediately on construction. Default false (the React provider sets this). */
  autoConnect?: boolean;
  /** Refresh the JWT this many ms before it expires. */
  tokenSkewMs?: number;
  /** How long `getJwt()` waits for a fresh token before rejecting. */
  tokenRequestTimeoutMs?: number;
  /** Auto re-join this many ms after a `rejected` (e.g. duplicate tab clears). 0 disables. */
  retryRejectedMs?: number;
}
