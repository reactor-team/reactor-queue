import { DEFAULTS, DEFAULT_ROOM } from "@reactor-team/queue-protocol";

/** Passed to a custom {@link ReactorQueueServerConfig.acquireSession}. */
export interface AcquireSessionContext {
  /** The configured model name. */
  model: string;
}

/** Passed to a custom {@link ReactorQueueServerConfig.releaseSession}. */
export interface ReleaseSessionContext {
  /** The Reactor session the user was in. */
  sessionId: string;
  /** The connection id of the user who left. */
  userId: string;
  /** Why they left: `timeout`, `grace_timeout`, or `server`. */
  reason: string;
  /** True if they were the last member — the session is now empty. */
  lastMember: boolean;
}

export type AcquireSessionFn = (ctx: AcquireSessionContext) => Promise<string>;
export type ReleaseSessionFn = (ctx: ReleaseSessionContext) => Promise<void>;

/**
 * Operator-facing configuration for the queue server.
 *
 * Every field is optional. Resolution order (last wins): built-in default →
 * value passed to {@link createReactorQueueServer} → environment variable
 * (PartyKit `room.env`). Putting env last lets you bake sensible defaults into
 * code and still tune a deployment without a redeploy.
 */
export interface ReactorQueueServerConfig {
  /** Max concurrent Reactor sessions (GPU ceiling). Env: `RQ_MAX_SESSIONS`. */
  maxSessions?: number;
  /** Members per session. Env: `RQ_USERS_PER_SESSION`. */
  usersPerSession?: number;
  /** Model name for `POST /sessions`. Env: `RQ_MODEL`. Required. */
  model?: string;
  /** WebRTC transport version for session create. Env: `RQ_WEBRTC_VERSION`. */
  webrtcVersion?: string;
  /** Full session budget after claim, in ms. Env: `RQ_SESSION_DURATION_MS`. */
  sessionDurationMs?: number;
  /** Grace window to claim an admitted slot, in ms. Env: `RQ_ADMISSION_GRACE_MS`. */
  admissionGraceMs?: number;
  /** Lead time for the `time_warning`, in ms. Env: `RQ_WARNING_BEFORE_MS`. */
  warningBeforeMs?: number;
  /** Requested lifetime for each minted Reactor JWT, in seconds. Env: `RQ_TOKEN_TTL_SECONDS`. */
  tokenTtlSeconds?: number;
  /** How often to reconcile tracked sessions with Reactor, in ms. Env: `RQ_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;

  /** Reactor Coordinator base URL. Env: `RQ_COORDINATOR_URL`. Default `https://api.reactor.inc`. */
  coordinatorUrl?: string;
  /**
   * Reactor API key (`rk_...`). **Server-side secret** — set it via a PartyKit
   * secret (`RQ_REACTOR_API_KEY`), never bake it into code that ships to
   * clients. Required for the server to mint JWTs and reap sessions.
   */
  apiKey?: string;
  /** `Reactor-API-Version` header value. Env: `RQ_API_VERSION`. Default `1`. */
  apiVersion?: number;

  /**
   * When true (default), the server calls `DELETE /sessions/{id}` the moment a
   * user's time runs out or they vanish, instead of waiting for Reactor's own
   * idle timeout. Env: `RQ_STOP_SESSIONS=false` to disable.
   */
  stopSessionsOnExpiry?: boolean;

  /**
   * Password for admin dashboard connections (`rqAdmin=1` on the WebSocket URL).
   * Env: `RQ_ADMIN_PASSWORD`. When unset, admin mode is disabled.
   */
  adminPassword?: string;

  /**
   * Allow the same browser (stable `clientId`) to hold multiple simultaneous
   * connections. Default false: a second tab is rejected with `already_connected`.
   * Env: `RQ_ALLOW_DUPLICATE_CONNECTIONS=true`.
   */
  allowDuplicateConnections?: boolean;

  /**
   * Override how a session id is obtained when an admitted user `claim()`s.
   * Default: create one via the Reactor API (`POST /sessions`). Override to
   * source sessions from elsewhere — e.g. lease a pre-provisioned session from
   * another service that already has a different kind of client attached.
   * Called once per session (the first member's claim). Not configurable via
   * env — pass a function.
   */
  acquireSession?: AcquireSessionFn;

  /**
   * Called when a user **leaves** a session (timeout, disconnect, end, or kick),
   * with their `userId` and whether they were the `lastMember`. Default: when
   * the last member leaves, delete the session via the Reactor API
   * (`DELETE /sessions/{id}`, subject to `stopSessionsOnExpiry`). Override to
   * keep the session alive and just react to the departure (e.g. hand it back to
   * the owning service to be reset and reused). Not configurable via env — pass
   * a function.
   */
  releaseSession?: ReleaseSessionFn;

  /** Optional lifecycle hooks for logging / metrics. Not configurable via env. */
  hooks?: ReactorQueueServerHooks;
}

export interface ReactorQueueServerHooks {
  onUserConnected?: (connId: string) => void;
  onUserDisconnected?: (connId: string) => void;
  onUserEnteredSession?: (connId: string, sessionId: string) => void;
  onSessionCreated?: (sessionId: string) => void;
  onSessionClosed?: (sessionId: string, reason: string) => void;
  onError?: (where: string, error: unknown) => void;
}

/** Fully-resolved config with all values present. */
export interface ResolvedConfig {
  maxSessions: number;
  usersPerSession: number;
  model: string;
  webrtcVersion: string;
  sessionDurationMs: number;
  admissionGraceMs: number;
  warningBeforeMs: number;
  tokenTtlSeconds: number;
  pollIntervalMs: number;
  coordinatorUrl: string;
  apiKey: string;
  apiVersion: number;
  stopSessionsOnExpiry: boolean;
  hooks: ReactorQueueServerHooks;
  /** Total live users = maxSessions * usersPerSession. */
  capacity: number;
  /** When set, admin WebSocket connections may authenticate with this password. */
  adminPassword: string | null;
  /** When true, the duplicate-tab (same `clientId`) rejection is disabled. */
  allowDuplicateConnections: boolean;
  /** Custom session acquisition, or null to create via the Reactor API. */
  acquireSession: AcquireSessionFn | null;
  /** Custom user-left handler, or null to delete via the Reactor API on last member. */
  releaseSession: ReleaseSessionFn | null;
}

const DEFAULT_COORDINATOR_URL = "https://api.reactor.inc";
const DEFAULT_WEBRTC_VERSION = "1.0";

type Env = Record<string, unknown>;

function envNum(env: Env, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function envStr(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  return String(raw);
}

function envBool(env: Env, key: string): boolean | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const s = String(raw).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function pickNum(envVal: number | undefined, cfgVal: number | undefined, def: number): number {
  if (envVal !== undefined && envVal > 0) return envVal;
  if (cfgVal !== undefined && cfgVal > 0) return cfgVal;
  return def;
}

/**
 * Merge built-in defaults, factory config, and `room.env` into a single
 * resolved config object. Throws if the API key or model is missing.
 */
export function resolveConfig(config: ReactorQueueServerConfig, env: Env): ResolvedConfig {
  const apiKey = envStr(env, "RQ_REACTOR_API_KEY") ?? config.apiKey;
  if (!apiKey) {
    throw new Error(
      "[reactor-queue] No Reactor API key. Set the RQ_REACTOR_API_KEY secret " +
        "(`npx partykit secret put RQ_REACTOR_API_KEY`) or pass `apiKey` to createReactorQueueServer()."
    );
  }

  const model = envStr(env, "RQ_MODEL") ?? config.model;
  if (!model) {
    throw new Error(
      "[reactor-queue] No model configured. Set RQ_MODEL (e.g. helios) or pass `model` to createReactorQueueServer()."
    );
  }

  const maxSessions = pickNum(
    envNum(env, "RQ_MAX_SESSIONS"),
    config.maxSessions,
    DEFAULTS.maxSessions
  );
  const usersPerSession = pickNum(
    envNum(env, "RQ_USERS_PER_SESSION"),
    config.usersPerSession,
    DEFAULTS.usersPerSession
  );

  return {
    maxSessions,
    usersPerSession,
    model,
    webrtcVersion: envStr(env, "RQ_WEBRTC_VERSION") ?? config.webrtcVersion ?? DEFAULT_WEBRTC_VERSION,
    sessionDurationMs: pickNum(
      envNum(env, "RQ_SESSION_DURATION_MS"),
      config.sessionDurationMs,
      DEFAULTS.sessionDurationMs
    ),
    admissionGraceMs: pickNum(
      envNum(env, "RQ_ADMISSION_GRACE_MS"),
      config.admissionGraceMs,
      DEFAULTS.admissionGraceMs
    ),
    warningBeforeMs: pickNum(
      envNum(env, "RQ_WARNING_BEFORE_MS"),
      config.warningBeforeMs,
      DEFAULTS.warningBeforeMs
    ),
    tokenTtlSeconds: pickNum(
      envNum(env, "RQ_TOKEN_TTL_SECONDS"),
      config.tokenTtlSeconds,
      DEFAULTS.tokenTtlSeconds
    ),
    pollIntervalMs: pickNum(
      envNum(env, "RQ_POLL_INTERVAL_MS"),
      config.pollIntervalMs,
      DEFAULTS.pollIntervalMs
    ),
    coordinatorUrl: (
      envStr(env, "RQ_COORDINATOR_URL") ??
      config.coordinatorUrl ??
      DEFAULT_COORDINATOR_URL
    ).replace(/\/+$/, ""),
    apiKey,
    apiVersion: pickNum(envNum(env, "RQ_API_VERSION"), config.apiVersion, 1),
    stopSessionsOnExpiry:
      envBool(env, "RQ_STOP_SESSIONS") ?? config.stopSessionsOnExpiry ?? true,
    hooks: config.hooks ?? {},
    capacity: maxSessions * usersPerSession,
    adminPassword: envStr(env, "RQ_ADMIN_PASSWORD") ?? config.adminPassword ?? null,
    allowDuplicateConnections:
      envBool(env, "RQ_ALLOW_DUPLICATE_CONNECTIONS") ??
      config.allowDuplicateConnections ??
      false,
    acquireSession: config.acquireSession ?? null,
    releaseSession: config.releaseSession ?? null,
  };
}

export { DEFAULT_ROOM };
