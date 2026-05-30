import { DEFAULTS, DEFAULT_ROOM } from "@reactor-team/queue-protocol";

/**
 * Operator-facing configuration for the queue server.
 *
 * Every field is optional. Resolution order (last wins): built-in default →
 * value passed to {@link createReactorQueueServer} → environment variable
 * (PartyKit `room.env`). Putting env last lets you bake sensible defaults into
 * code and still tune a deployment without a redeploy.
 */
export interface ReactorQueueServerConfig {
  /** Max users holding a live Reactor session at once. Env: `RQ_MAX_CONCURRENT`. */
  maxConcurrent?: number;
  /** Full session budget after claim, in ms. Env: `RQ_SESSION_DURATION_MS`. */
  sessionDurationMs?: number;
  /** Grace window to claim an admitted slot, in ms. Env: `RQ_ADMISSION_GRACE_MS`. */
  admissionGraceMs?: number;
  /** Lead time for the `time_warning`, in ms. Env: `RQ_WARNING_BEFORE_MS`. */
  warningBeforeMs?: number;
  /** Requested lifetime for each minted Reactor JWT, in seconds. Env: `RQ_TOKEN_TTL_SECONDS`. */
  tokenTtlSeconds?: number;
  /** A heartbeat older than this marks a connection dead. Env: `RQ_HEARTBEAT_STALE_MS`. */
  heartbeatStaleMs?: number;
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

  /** Optional lifecycle hooks for logging / metrics. Not configurable via env. */
  hooks?: ReactorQueueServerHooks;
}

export interface ReactorQueueServerHooks {
  onAdmit?: (connId: string) => void;
  onClaim?: (connId: string) => void;
  onExpire?: (connId: string, sessionId: string | undefined, reason: string) => void;
  onSessionReaped?: (connId: string, sessionId: string, state: string) => void;
  onError?: (where: string, error: unknown) => void;
}

/** Fully-resolved config with all values present. */
export interface ResolvedConfig {
  maxConcurrent: number;
  sessionDurationMs: number;
  admissionGraceMs: number;
  warningBeforeMs: number;
  tokenTtlSeconds: number;
  heartbeatStaleMs: number;
  pollIntervalMs: number;
  coordinatorUrl: string;
  apiKey: string;
  apiVersion: number;
  stopSessionsOnExpiry: boolean;
  hooks: ReactorQueueServerHooks;
}

const DEFAULT_COORDINATOR_URL = "https://api.reactor.inc";

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
 * resolved config object. Throws if the API key is missing, since the server
 * cannot mint tokens without it.
 */
export function resolveConfig(config: ReactorQueueServerConfig, env: Env): ResolvedConfig {
  const apiKey = envStr(env, "RQ_REACTOR_API_KEY") ?? config.apiKey;
  if (!apiKey) {
    throw new Error(
      "[reactor-queue] No Reactor API key. Set the RQ_REACTOR_API_KEY secret " +
        "(`npx partykit secret put RQ_REACTOR_API_KEY`) or pass `apiKey` to createReactorQueueServer()."
    );
  }

  return {
    maxConcurrent: pickNum(
      envNum(env, "RQ_MAX_CONCURRENT"),
      config.maxConcurrent,
      DEFAULTS.maxConcurrent
    ),
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
    heartbeatStaleMs: pickNum(
      envNum(env, "RQ_HEARTBEAT_STALE_MS"),
      config.heartbeatStaleMs,
      DEFAULTS.heartbeatStaleMs
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
  };
}

export { DEFAULT_ROOM };
