import type {
  AdminConfigSnapshot,
  AdminMemberSnapshot,
  AdminQueuedUserSnapshot,
  AdminSessionSnapshot,
  AdminSnapshotMessage,
} from "@reactor-team/queue-protocol";
import type { ResolvedConfig } from "./config";

interface MemberData {
  sessionId: string;
  expiresAt: number;
  claimed: boolean;
}

interface SessionRecord {
  sessionId: string;
  members: string[];
  createdAt: number;
}

export function configSnapshot(c: ResolvedConfig): AdminConfigSnapshot {
  return {
    maxSessions: c.maxSessions,
    usersPerSession: c.usersPerSession,
    capacity: c.capacity,
    model: c.model,
    webrtcVersion: c.webrtcVersion,
    sessionDurationMs: c.sessionDurationMs,
    admissionGraceMs: c.admissionGraceMs,
    warningBeforeMs: c.warningBeforeMs,
    tokenTtlSeconds: c.tokenTtlSeconds,
    heartbeatStaleMs: c.heartbeatStaleMs,
    pollIntervalMs: c.pollIntervalMs,
    coordinatorUrl: c.coordinatorUrl,
    apiVersion: c.apiVersion,
    stopSessionsOnExpiry: c.stopSessionsOnExpiry,
  };
}

export function buildAdminSnapshot(opts: {
  config: ResolvedConfig;
  queue: string[];
  sessions: Map<string, SessionRecord>;
  members: Map<string, MemberData>;
  resolveClientId: (connId: string) => Promise<string | null>;
}): Promise<AdminSnapshotMessage> {
  const now = Date.now();
  return (async () => {
    const queue: AdminQueuedUserSnapshot[] = [];
    for (let i = 0; i < opts.queue.length; i++) {
      const connId = opts.queue[i]!;
      queue.push({
        connId,
        position: i + 1,
        clientId: await opts.resolveClientId(connId),
      });
    }

    const sessions: AdminSessionSnapshot[] = [];
    for (const [, rec] of opts.sessions) {
      sessions.push({
        sessionId: rec.sessionId,
        members: [...rec.members],
        createdAt: rec.createdAt,
        msSinceCreated: now - rec.createdAt,
      });
    }
    sessions.sort((a, b) => a.createdAt - b.createdAt);

    const members: AdminMemberSnapshot[] = [];
    for (const [key, data] of opts.members) {
      const connId = key.replace("member:", "");
      members.push({
        connId,
        sessionId: data.sessionId,
        clientId: await opts.resolveClientId(connId),
        claimed: data.claimed,
        expiresAt: data.expiresAt,
        msLeft: Math.max(0, data.expiresAt - now),
      });
    }
    members.sort((a, b) => a.expiresAt - b.expiresAt);

    return {
      type: "admin_snapshot",
      at: now,
      activeCount: opts.members.size,
      sessionCount: opts.sessions.size,
      config: configSnapshot(opts.config),
      queue,
      sessions,
      members,
    };
  })();
}
