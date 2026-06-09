import { describe, it, expect } from "vitest";
import { buildAdminSnapshot, configSnapshot } from "../src/server/admin-snapshot";
import { resolveConfig } from "../src/server/config";

const cfg = resolveConfig(
  { apiKey: "rk_test", model: "helios", maxSessions: 2, usersPerSession: 2 },
  {}
);

describe("configSnapshot", () => {
  it("projects the operator-visible config fields", () => {
    const snap = configSnapshot(cfg);
    expect(snap.model).toBe("helios");
    expect(snap.maxSessions).toBe(2);
    expect(snap.usersPerSession).toBe(2);
    expect(snap.capacity).toBe(4);
    expect(snap.sessionSource).toBe("default");
  });

  it("reports sessionSource 'custom' when acquire or release is overridden", () => {
    const custom = resolveConfig(
      { apiKey: "rk_test", model: "helios", acquireSession: async () => "s" },
      {}
    );
    expect(configSnapshot(custom).sessionSource).toBe("custom");
  });
});

describe("buildAdminSnapshot", () => {
  const resolveClientId = async (connId: string) => `client-${connId}`;

  it("numbers the queue 1-based and resolves client ids", async () => {
    const snap = await buildAdminSnapshot({
      config: cfg,
      queue: ["a", "b", "c"],
      slots: new Map(),
      members: new Map(),
      resolveClientId,
    });
    expect(snap.queue).toEqual([
      { connId: "a", position: 1, clientId: "client-a" },
      { connId: "b", position: 2, clientId: "client-b" },
      { connId: "c", position: 3, clientId: "client-c" },
    ]);
  });

  it("counts only sessions that actually have a Reactor session id", async () => {
    const slots = new Map([
      ["slot:1", { slotId: "1", sessionId: "sess-1", members: ["a"], createdAt: 100 }],
      // Reserved during grace: a slot exists but no session was created yet.
      ["slot:2", { slotId: "2", sessionId: null, members: ["b"], createdAt: 50 }],
    ]);
    const snap = await buildAdminSnapshot({
      config: cfg,
      queue: [],
      slots,
      members: new Map(),
      resolveClientId,
    });
    expect(snap.sessionCount).toBe(1);
    expect(snap.sessions).toHaveLength(2);
    // Sorted by createdAt ascending — the reserved (50) slot comes first.
    expect(snap.sessions.map((s) => s.sessionId)).toEqual([null, "sess-1"]);
  });

  it("sorts members by expiry and floors msLeft at zero", async () => {
    const now = Date.now();
    const members = new Map([
      ["member:late", { sessionId: "s", connectionId: 2, expiresAt: now + 10_000, claimed: true }],
      [
        "member:past",
        { sessionId: null, connectionId: null, expiresAt: now - 5_000, claimed: false },
      ],
    ]);
    const snap = await buildAdminSnapshot({
      config: cfg,
      queue: [],
      slots: new Map(),
      members,
      resolveClientId,
    });
    expect(snap.activeCount).toBe(2);
    expect(snap.members.map((m) => m.connId)).toEqual(["past", "late"]);
    expect(snap.members[0]!.msLeft).toBe(0);
    expect(snap.members[1]!.msLeft).toBeGreaterThan(0);
    expect(snap.members[1]!.claimed).toBe(true);
    expect(snap.members[1]!.connectionId).toBe(2);
  });
});
