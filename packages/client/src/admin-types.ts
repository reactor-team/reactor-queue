import type {
  AdminActionResultMessage,
  AdminLogEntry,
  AdminSnapshotMessage,
} from "@reactor-team/queue-protocol";

export type AdminPhase = "idle" | "connecting" | "ready" | "rejected" | "disconnected";

export interface AdminState {
  phase: AdminPhase;
  snapshot: AdminSnapshotMessage | null;
  reason: string | null;
  lastAction: AdminActionResultMessage | null;
  /**
   * Activity log, oldest → newest. Seeded with recent history on connect, then
   * appended live as the server streams events. Capped client-side (newest kept).
   */
  logs: AdminLogEntry[];
}

export const INITIAL_ADMIN_STATE: AdminState = {
  phase: "idle",
  snapshot: null,
  reason: null,
  lastAction: null,
  logs: [],
};

/** Max log entries retained client-side. The newest are kept past this. */
export const MAX_CLIENT_LOGS = 300;

export type AdminPasswordSource = string | (() => string | Promise<string>);

export interface ReactorQueueAdminClientOptions {
  host: string;
  room?: string;
  party?: string;
  /** How the client authenticates. You supply the secret (env, input, hardcoded, etc.). */
  password: AdminPasswordSource;
  autoConnect?: boolean;
  /**
   * Poll a fresh snapshot every N ms once authenticated. The server also pushes
   * on every room change; polling keeps the `msLeft` countdowns live. 0 disables.
   */
  refreshIntervalMs?: number;
}
