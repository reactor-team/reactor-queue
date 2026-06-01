"use client";

import { CSSProperties, useState } from "react";
import Link from "next/link";
import { ReactorQueueAdminProvider, useReactorQueueAdmin } from "@reactor-team/queue/admin/react";

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST;

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [connected, setConnected] = useState(false);

  if (!PARTYKIT_HOST) {
    return (
      <Shell>
        <Card>
          <h1 style={s.h1}>Setup</h1>
          <p style={s.muted}>
            Set <code>NEXT_PUBLIC_PARTYKIT_HOST</code> and <code>RQ_ADMIN_PASSWORD</code> in{" "}
            <code>.env</code>, then run <code>pnpm dev</code>.
          </p>
        </Card>
      </Shell>
    );
  }

  if (!connected) {
    return (
      <Shell>
        <Card>
          <div style={s.rowBetween}>
            <h1 style={s.h1}>Queue admin</h1>
            <Link href="/" style={s.link}>
              ← Demo
            </Link>
          </div>
          <p style={s.muted}>
            Password must match <code>RQ_ADMIN_PASSWORD</code> in your <code>.env</code> (loaded by PartyKit).
          </p>
          <label style={s.label}>
            Admin password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={s.input}
              autoComplete="current-password"
            />
          </label>
          <button
            type="button"
            style={s.btnPrimary}
            disabled={!password}
            onClick={() => setConnected(true)}
          >
            Connect
          </button>
        </Card>
      </Shell>
    );
  }

  return (
    <ReactorQueueAdminProvider
      host={PARTYKIT_HOST}
      password={password}
      autoConnect
      refreshIntervalMs={10_000}
    >
      <Dashboard onDisconnect={() => setConnected(false)} />
    </ReactorQueueAdminProvider>
  );
}

function Dashboard({ onDisconnect }: { onDisconnect: () => void }) {
  const admin = useReactorQueueAdmin();
  const snapshot = admin.snapshot;

  if (admin.phase === "rejected") {
    return (
      <Shell>
        <Card>
          <h1 style={s.h1}>Access denied</h1>
          <p style={s.muted}>{admin.reason ?? "invalid_password"}</p>
          <button type="button" style={s.btnPrimary} onClick={onDisconnect}>
            Try again
          </button>
        </Card>
      </Shell>
    );
  }

  if (admin.phase !== "ready" || !snapshot) {
    return (
      <Shell>
        <Card>
          <Spinner />
          <p style={{ ...s.muted, marginTop: 16 }}>Connecting to admin channel…</p>
        </Card>
      </Shell>
    );
  }

  const cfg = snapshot.config;
  const memberByConn = new Map(snapshot.members.map((m) => [m.connId, m]));
  const waiting = snapshot.queue.length;
  const live = snapshot.members.length;
  const total = waiting + live;

  return (
    <Shell wide>
      <header style={s.header}>
        <div>
          <h1 style={s.h1}>Queue admin</h1>
          <p style={s.muted}>
            Live at {new Date(snapshot.at).toLocaleTimeString()} · updates push over the WebSocket
          </p>
        </div>
        <div style={s.headerActions}>
          <Link href="/" style={s.link}>
            Demo
          </Link>
          <button type="button" style={s.btnGhost} onClick={() => admin.refresh()}>
            Refresh
          </button>
          <button
            type="button"
            style={s.btnGhost}
            onClick={() => {
              admin.disconnect();
              onDisconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      </header>

      {admin.lastAction && (
        <div
          style={{
            ...s.banner,
            borderColor: admin.lastAction.ok ? "#166534" : "#991b1b",
            color: admin.lastAction.ok ? "#86efac" : "#fca5a5",
          }}
        >
          {admin.lastAction.action}: {admin.lastAction.ok ? "ok" : admin.lastAction.message}
        </div>
      )}

      {/* Top: config (1/4) + big numbers (3/4) */}
      <div style={s.topGrid}>
        <Card>
          <h2 style={s.h2}>Configuration</h2>
          <div style={s.cfgList}>
            <ConfigRow label="Model" value={cfg.model} />
            <ConfigRow label="Max sessions" value={String(cfg.maxSessions)} />
            <ConfigRow label="Users / session" value={String(cfg.usersPerSession)} />
            <ConfigRow label="Capacity" value={String(cfg.capacity)} />
            <ConfigRow label="Session duration" value={`${cfg.sessionDurationMs / 1000}s`} />
            <ConfigRow label="Admission grace" value={`${cfg.admissionGraceMs / 1000}s`} />
            <ConfigRow label="Token TTL" value={`${cfg.tokenTtlSeconds}s`} />
            <ConfigRow label="Poll interval" value={`${cfg.pollIntervalMs / 1000}s`} />
            <ConfigRow label="Stop on expiry" value={cfg.stopSessionsOnExpiry ? "yes" : "no"} />
            <ConfigRow label="WebRTC" value={cfg.webrtcVersion} />
            <ConfigRow label="API version" value={String(cfg.apiVersion)} />
            <ConfigRow label="Coordinator" value={cfg.coordinatorUrl} />
          </div>
        </Card>

        <Card>
          <div style={s.bigGrid}>
            <BigNumber
              value={waiting}
              label="Waiting"
              description="Users in the queue, waiting to be admitted"
              color="#d9b15e"
            />
            <BigNumber
              value={live}
              label="Live members"
              description="Users past the queue — claiming or connected"
              color="#4ade80"
            />
            <BigNumber
              value={total}
              label="Connected"
              description="Total connected users (waiting + live)"
              color="#60a5fa"
            />
            <BigNumber
              value={snapshot.sessionCount}
              label="Active sessions"
              description={`Each session holds up to ${cfg.usersPerSession} user${
                cfg.usersPerSession === 1 ? "" : "s"
              }`}
              color="#c084fc"
            />
          </div>
        </Card>
      </div>

      {/* Active Reactor sessions */}
      <section style={s.section}>
        <h2 style={s.h2}>Active Reactor sessions ({snapshot.sessions.length})</h2>
        {snapshot.sessions.length === 0 ? (
          <Card>
            <p style={s.muted}>No active sessions.</p>
          </Card>
        ) : (
          <div style={s.sessionGrid}>
            {snapshot.sessions.map((sess) => (
              <div key={sess.sessionId} style={s.sessionCard}>
                <div style={s.rowBetween}>
                  <div>
                    <div style={s.sessionId}>{shortId(sess.sessionId)}</div>
                    <div style={s.muted}>
                      {sess.members.length} / {cfg.usersPerSession} users · age{" "}
                      {formatMs(sess.msSinceCreated)}
                    </div>
                  </div>
                  <button
                    type="button"
                    style={s.btnDanger}
                    onClick={() => admin.closeSession(sess.sessionId)}
                  >
                    Close session
                  </button>
                </div>
                <div style={s.memberRows}>
                  {sess.members.length === 0 ? (
                    <p style={s.muted}>No members.</p>
                  ) : (
                    sess.members.map((connId) => {
                      const m = memberByConn.get(connId);
                      return (
                        <div key={connId} style={s.memberRow}>
                          <span style={s.mono}>{shortId(connId)}</span>
                          <span style={s.memberMeta}>
                            {m ? (m.claimed ? "active" : "grace") : "—"}
                            {m ? ` · ${formatMs(m.msLeft)}` : ""}
                          </span>
                          <button
                            type="button"
                            style={s.btnDanger}
                            onClick={() => admin.kickMember(connId)}
                          >
                            Evict
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Queue */}
      <section style={s.section}>
        <h2 style={s.h2}>Queue ({snapshot.queue.length})</h2>
        <Card>
          {snapshot.queue.length === 0 ? (
            <p style={s.muted}>Nobody waiting.</p>
          ) : (
            <div style={s.queueList}>
              {snapshot.queue.map((row) => (
                <div key={row.connId} style={s.queueRow}>
                  <span style={s.queuePos}>#{row.position}</span>
                  <span style={s.mono}>{shortId(row.connId)}</span>
                  <span style={s.queueClient}>
                    {row.clientId ? shortId(row.clientId) : "—"}
                  </span>
                  <button
                    type="button"
                    style={s.btnDanger}
                    onClick={() => admin.kickQueued(row.connId)}
                  >
                    Evict
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>
    </Shell>
  );
}

function BigNumber({
  value,
  label,
  description,
  color,
}: {
  value: number;
  label: string;
  description: string;
  color: string;
}) {
  return (
    <div style={{ ...s.bigCard, borderColor: color }}>
      <div style={{ ...s.bigValue, color }}>{value}</div>
      <div style={s.bigLabel}>{label}</div>
      <div style={s.bigDesc}>{description}</div>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={s.cfgRow}>
      <span style={s.cfgLabel}>{label}</span>
      <span style={s.cfgValue}>{value}</span>
    </div>
  );
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function formatMs(ms: number): string {
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main style={{ ...s.page, maxWidth: wide ? 1100 : 420 }}>
      {children}
    </main>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div style={s.card}>{children}</div>;
}

function Spinner() {
  return <span style={s.spinner} />;
}

const s: Record<string, CSSProperties> = {
  page: { minHeight: "100vh", margin: "0 auto", padding: "24px 20px 48px" },
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 24,
  },
  headerActions: { display: "flex", alignItems: "center", gap: 12 },
  card: {
    border: "1px solid #27272a",
    background: "rgba(24,24,27,0.5)",
    borderRadius: 12,
    padding: 24,
  },
  h1: { fontSize: 22, fontWeight: 600, margin: 0 },
  h2: { fontSize: 14, fontWeight: 600, margin: "0 0 12px", letterSpacing: 0.3 },
  muted: { fontSize: 13, color: "#a1a1aa", marginTop: 4, lineHeight: 1.5 },
  footerMuted: { fontSize: 11, color: "#52525b", marginTop: 32, textAlign: "center" },
  label: { display: "block", fontSize: 12, color: "#a1a1aa", marginTop: 20 },
  input: {
    display: "block",
    width: "100%",
    marginTop: 8,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#fafafa",
    fontSize: 14,
  },
  btnPrimary: {
    marginTop: 20,
    width: "100%",
    border: "none",
    borderRadius: 8,
    background: "#d9b15e",
    color: "#0b1020",
    fontWeight: 600,
    fontSize: 14,
    padding: "10px 16px",
    cursor: "pointer",
  },
  btnGhost: {
    border: "1px solid #3f3f46",
    borderRadius: 8,
    background: "transparent",
    color: "#d4d4d8",
    fontSize: 13,
    padding: "6px 12px",
    cursor: "pointer",
  },
  btnDanger: {
    border: "1px solid #7f1d1d",
    borderRadius: 6,
    background: "rgba(127,29,29,0.25)",
    color: "#fca5a5",
    fontSize: 12,
    padding: "4px 10px",
    cursor: "pointer",
  },
  link: { fontSize: 13, color: "#d9b15e", textDecoration: "none" },
  rowBetween: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  banner: {
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: 8,
    padding: "10px 14px",
    marginBottom: 20,
    fontSize: 13,
  },
  section: { marginBottom: 28 },
  topGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(220px, 1fr) 3fr",
    gap: 20,
    marginBottom: 28,
    alignItems: "start",
  },
  cfgList: { display: "flex", flexDirection: "column" },
  cfgRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
    padding: "8px 0",
    borderBottom: "1px solid #1f1f23",
  },
  cfgLabel: { fontSize: 12, color: "#71717a" },
  cfgValue: {
    fontSize: 12,
    color: "#e4e4e7",
    fontFamily: "ui-monospace, monospace",
    textAlign: "right",
    wordBreak: "break-all",
    maxWidth: "60%",
  },
  bigGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 16,
  },
  bigCard: {
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: 12,
    padding: 18,
    background: "rgba(24,24,27,0.35)",
    display: "flex",
    flexDirection: "column",
    minHeight: 130,
  },
  bigValue: { fontSize: 44, fontWeight: 700, lineHeight: 1 },
  bigLabel: { fontSize: 13, fontWeight: 600, color: "#e4e4e7", marginTop: 10 },
  bigDesc: { fontSize: 11, color: "#a1a1aa", marginTop: 6, lineHeight: 1.4 },
  mono: { fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#d4d4d8" },
  sessionGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    gap: 16,
  },
  sessionCard: {
    border: "1px solid #27272a",
    borderRadius: 12,
    padding: 16,
    background: "rgba(24,24,27,0.5)",
  },
  sessionId: { fontFamily: "ui-monospace, monospace", fontSize: 15, color: "#d9b15e" },
  memberRows: {
    marginTop: 14,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  memberRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 8,
    background: "rgba(0,0,0,0.25)",
  },
  memberMeta: { flex: 1, fontSize: 11, color: "#a1a1aa" },
  queueList: { display: "flex", flexDirection: "column", gap: 8 },
  queueRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    borderRadius: 8,
    background: "rgba(0,0,0,0.25)",
  },
  queuePos: { fontSize: 14, fontWeight: 600, color: "#d9b15e", minWidth: 36 },
  queueClient: { flex: 1, fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#71717a" },
  spinner: {
    display: "inline-block",
    width: 24,
    height: 24,
    border: "2px solid #3f3f46",
    borderTopColor: "#d9b15e",
    borderRadius: 999,
    animation: "spin 0.8s linear infinite",
  },
};
