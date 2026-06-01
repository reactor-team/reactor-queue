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

  return (
    <Shell wide>
      <header style={s.header}>
        <div>
          <h1 style={s.h1}>Queue admin</h1>
          <p style={s.muted}>
            {snapshot.activeCount}/{cfg.capacity} live · {snapshot.sessionCount}/{cfg.maxSessions}{" "}
            sessions · {snapshot.queue.length} waiting
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

      <section style={s.section}>
        <h2 style={s.h2}>Configuration</h2>
        <div style={s.configGrid}>
          <ConfigItem label="Model" value={cfg.model} />
          <ConfigItem label="Max sessions" value={String(cfg.maxSessions)} />
          <ConfigItem label="Users / session" value={String(cfg.usersPerSession)} />
          <ConfigItem label="Capacity" value={String(cfg.capacity)} />
          <ConfigItem label="Session duration" value={`${cfg.sessionDurationMs / 1000}s`} />
          <ConfigItem label="Admission grace" value={`${cfg.admissionGraceMs / 1000}s`} />
          <ConfigItem label="Token TTL" value={`${cfg.tokenTtlSeconds}s`} />
          <ConfigItem label="Stop on expiry" value={cfg.stopSessionsOnExpiry ? "yes" : "no"} />
          <ConfigItem label="Coordinator" value={cfg.coordinatorUrl} wide />
        </div>
      </section>

      <div style={s.columns}>
        <section style={s.section}>
          <h2 style={s.h2}>Waiting ({snapshot.queue.length})</h2>
          {snapshot.queue.length === 0 ? (
            <p style={s.muted}>Nobody in line.</p>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>#</th>
                  <th style={s.th}>Connection</th>
                  <th style={s.th}>Client id</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.queue.map((row) => (
                  <tr key={row.connId}>
                    <td style={s.td}>{row.position}</td>
                    <td style={s.tdMono}>{shortId(row.connId)}</td>
                    <td style={s.tdMono}>{row.clientId ? shortId(row.clientId) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Live members ({snapshot.members.length})</h2>
          {snapshot.members.length === 0 ? (
            <p style={s.muted}>No admitted users.</p>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Connection</th>
                  <th style={s.th}>Session</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Left</th>
                  <th style={s.th} />
                </tr>
              </thead>
              <tbody>
                {snapshot.members.map((m) => (
                  <tr key={m.connId}>
                    <td style={s.tdMono}>{shortId(m.connId)}</td>
                    <td style={s.tdMono}>{shortId(m.sessionId)}</td>
                    <td style={s.td}>{m.claimed ? "active" : "grace"}</td>
                    <td style={s.td}>{formatMs(m.msLeft)}</td>
                    <td style={s.td}>
                      <button
                        type="button"
                        style={s.btnDanger}
                        onClick={() => admin.kickMember(m.connId)}
                      >
                        Kick
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section style={s.section}>
        <h2 style={s.h2}>Reactor sessions ({snapshot.sessions.length})</h2>
        {snapshot.sessions.length === 0 ? (
          <p style={s.muted}>No sessions.</p>
        ) : (
          <div style={s.sessionList}>
            {snapshot.sessions.map((sess) => (
              <div key={sess.sessionId} style={s.sessionCard}>
                <div style={s.rowBetween}>
                  <div>
                    <div style={s.sessionId}>{shortId(sess.sessionId)}</div>
                    <div style={s.muted}>
                      {sess.members.length} member(s) · age {formatMs(sess.msSinceCreated)}
                    </div>
                  </div>
                  <button
                    type="button"
                    style={s.btnDanger}
                    onClick={() => admin.closeSession(sess.sessionId)}
                  >
                    Force close
                  </button>
                </div>
                <ul style={s.memberList}>
                  {sess.members.map((connId) => (
                    <li key={connId} style={s.tdMono}>
                      {shortId(connId)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <p style={s.footerMuted}>
        Snapshot at {new Date(snapshot.at).toLocaleTimeString()} · updates push over the WebSocket
      </p>
    </Shell>
  );
}

function ConfigItem({
  label,
  value,
  wide,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div style={{ ...s.configItem, gridColumn: wide ? "1 / -1" : undefined }}>
      <div style={s.configLabel}>{label}</div>
      <div style={s.configValue}>{value}</div>
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
  columns: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 24,
  },
  configGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 12,
  },
  configItem: {
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: "10px 12px",
    background: "rgba(24,24,27,0.35)",
  },
  configLabel: {
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: "#71717a",
  },
  configValue: {
    fontSize: 13,
    color: "#e4e4e7",
    marginTop: 4,
    wordBreak: "break-all",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    borderBottom: "1px solid #27272a",
    color: "#71717a",
    fontWeight: 500,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  td: { padding: "10px", borderBottom: "1px solid #1f1f23", color: "#d4d4d8" },
  tdMono: {
    padding: "10px",
    borderBottom: "1px solid #1f1f23",
    color: "#d4d4d8",
    fontFamily: "ui-monospace, monospace",
    fontSize: 12,
  },
  sessionList: { display: "flex", flexDirection: "column", gap: 12 },
  sessionCard: {
    border: "1px solid #27272a",
    borderRadius: 10,
    padding: 14,
    background: "rgba(24,24,27,0.35)",
  },
  sessionId: { fontFamily: "ui-monospace, monospace", fontSize: 14, color: "#d9b15e" },
  memberList: { margin: "12px 0 0", paddingLeft: 18, color: "#a1a1aa", fontSize: 12 },
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
