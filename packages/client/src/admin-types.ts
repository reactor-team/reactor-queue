import type { AdminActionResultMessage, AdminSnapshotMessage } from "@reactor-team/queue-protocol";

export type AdminPhase = "idle" | "connecting" | "ready" | "rejected" | "disconnected";

export interface AdminState {
  phase: AdminPhase;
  snapshot: AdminSnapshotMessage | null;
  reason: string | null;
  lastAction: AdminActionResultMessage | null;
}

export const INITIAL_ADMIN_STATE: AdminState = {
  phase: "idle",
  snapshot: null,
  reason: null,
  lastAction: null,
};

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
