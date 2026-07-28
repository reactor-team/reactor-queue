import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createReactorQueueServer } from "../src/server/server";
import type { ReactorQueueServerConfig } from "../src/server/config";
import { FakeRoom, FakeConnection, makeContext } from "./helpers/party";
import { installCoordinatorFetch, type CoordinatorMock } from "./helpers/coordinator-fetch";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  server: { onConnect: Function; onMessage: Function; onClose: Function; onAlarm: Function };
  room: FakeRoom;
  api: CoordinatorMock;
  join(id: string, opts?: { clientId?: string; origin?: string | null }): Promise<FakeConnection>;
  send(conn: FakeConnection, msg: unknown): Promise<void>;
  close(conn: FakeConnection): Promise<void>;
  drop(conn: FakeConnection): void;
}

function makeHarness(config: Partial<ReactorQueueServerConfig> = {}): Harness {
  const api = installCoordinatorFetch();
  const room = new FakeRoom({});
  const ServerClass = createReactorQueueServer({
    apiKey: "rk_test",
    model: "helios",
    coordinatorUrl: "https://coord.test",
    warningBeforeMs: 0,
    ...config,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = new ServerClass(room as any) as any;

  return {
    server,
    room,
    api,
    async join(id, opts = {}) {
      const conn = room.register(new FakeConnection(id));
      await server.onConnect(
        conn,
        makeContext({ clientId: opts.clientId ?? id, origin: opts.origin })
      );
      return conn;
    },
    async send(conn, msg) {
      await server.onMessage(JSON.stringify(msg), conn);
    },
    async close(conn) {
      room.connections.delete(conn.id);
      await server.onClose(conn);
    },
    drop(conn) {
      room.connections.delete(conn.id);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admission, FIFO, and capacity", () => {
  it("admits the first user without touching the Coordinator", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1 });
    const a = await h.join("a");
    expect(a.types()).toContain("admitted");
    expect(h.api.calls).toHaveLength(0);
  });

  it("queues the second user behind a full capacity ceiling, 1-based", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1 });
    await h.join("a");
    const b = await h.join("b");
    const c = await h.join("c");
    expect(b.ofType("queue_position").at(-1)).toMatchObject({ position: 1, capacity: 1 });
    expect(c.ofType("queue_position").at(-1)).toMatchObject({ position: 2 });
  });
});

describe("claim creates the Reactor session lazily and mints a connection", () => {
  it("returns session_ready with the server-owned sessionId + connectionId", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1 });
    const a = await h.join("a");
    await h.send(a, { type: "claim" });

    const ready = a.ofType("session_ready").at(-1)!;
    expect(ready.sessionId).toBe("sess-1");
    expect(ready.connectionId).toBe(1);
    // One session created, one connection minted.
    expect(h.api.countTo("/sessions")).toBeGreaterThanOrEqual(1);
    expect(h.api.countTo("/connections")).toBe(1);
  });

  it("does not create a session during grace (no orphan if the user never claims)", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1 });
    await h.join("a");
    expect(h.api.countTo("/connections")).toBe(0);
    // /sessions only carries POST creates here (no session id appended).
    expect(
      h.api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/sessions"))
    ).toHaveLength(0);
  });
});

describe("freeing capacity slides the line", () => {
  it("session_ended releases the slot and admits the next waiter", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1 });
    const a = await h.join("a");
    const b = await h.join("b");
    await h.send(a, { type: "claim" });
    await h.send(a, { type: "session_ended" });

    expect(h.api.calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(b.types()).toContain("admitted");
  });

  it("a closed tab frees its admitted slot for the next waiter", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1 });
    const a = await h.join("a");
    const b = await h.join("b");
    await h.close(a);
    expect(b.types()).toContain("admitted");
  });
});

describe("duplicate-tab guard", () => {
  it("rejects a second connection from the same browser by default", async () => {
    const h = makeHarness({ maxSessions: 5 });
    await h.join("a", { clientId: "browser-1" });
    const dup = await h.join("b", { clientId: "browser-1" });
    expect(dup.ofType("rejected")[0]).toMatchObject({ reason: "already_connected" });
    expect(dup.closed).toBe(true);
  });

  it("allows duplicates when allowDuplicateConnections is set", async () => {
    const h = makeHarness({ maxSessions: 5, allowDuplicateConnections: true });
    await h.join("a", { clientId: "browser-1" });
    const dup = await h.join("b", { clientId: "browser-1" });
    expect(dup.types()).toContain("admitted");
  });
});

describe("origin allow-list", () => {
  it("rejects a disallowed origin before it can join", async () => {
    const h = makeHarness({ allowedOrigins: ["https://ok.test"] });
    const bad = await h.join("a", { origin: "https://evil.test" });
    expect(bad.ofType("rejected")[0]).toMatchObject({ reason: "forbidden_origin" });
    expect(bad.closed).toBe(true);
  });

  it("admits an allowed origin", async () => {
    const h = makeHarness({ allowedOrigins: ["https://ok.test"] });
    const ok = await h.join("a", { origin: "https://ok.test" });
    expect(ok.types()).toContain("admitted");
  });
});

describe("alarm: grace, expiry, warning, liveness, and reconciliation", () => {
  it("reclaims a slot whose admitted user never claimed (grace_timeout)", async () => {
    const h = makeHarness({ maxSessions: 1, admissionGraceMs: 10 });
    const a = await h.join("a");
    await sleep(25);
    await h.server.onAlarm();
    expect(a.ofType("expired").at(-1)).toMatchObject({ reason: "grace_timeout" });
    expect(await h.room.storage.get("member:a")).toBeUndefined();
  });

  it("stops the Reactor session when a claimed turn times out", async () => {
    const h = makeHarness({ maxSessions: 1, sessionDurationMs: 10, pollIntervalMs: 1_000_000 });
    const closed: string[] = [];
    const h2 = h; // keep ref
    const a = await h2.join("a");
    await h2.send(a, { type: "claim" });
    await sleep(25);
    await h2.server.onAlarm();
    expect(a.ofType("expired").at(-1)).toMatchObject({ reason: "timeout" });
    expect(h2.api.calls.some((c) => c.method === "DELETE")).toBe(true);
    void closed;
  });

  it("emits a time_warning before expiry", async () => {
    const h = makeHarness({
      maxSessions: 1,
      sessionDurationMs: 100_000,
      warningBeforeMs: 100_000,
      pollIntervalMs: 1_000_000,
    });
    const a = await h.join("a");
    await h.send(a, { type: "claim" });
    await h.server.onAlarm();
    expect(a.types()).toContain("time_warning");
  });

  it("reconciles a member whose socket vanished without an onClose", async () => {
    const h = makeHarness({ maxSessions: 1 });
    const a = await h.join("a");
    h.drop(a); // socket gone, but onClose never fired
    await h.server.onAlarm();
    expect(await h.room.storage.get("member:a")).toBeUndefined();
  });

  it("frees a slot when the platform reports the session terminal", async () => {
    const h = makeHarness({ maxSessions: 1, sessionDurationMs: 1_000_000 });
    const a = await h.join("a");
    await h.send(a, { type: "claim" });
    h.api.runtimeState = "CLOSED";
    await h.server.onAlarm();
    expect(a.ofType("expired").length).toBeGreaterThan(0);
    expect(await h.room.storage.get("member:a")).toBeUndefined();
  });
});

describe("usersPerSession > 1", () => {
  it("packs members into one session, each with a distinct connection", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 2 });
    const a = await h.join("a");
    const b = await h.join("b");
    await h.send(a, { type: "claim" });
    await h.send(b, { type: "claim" });

    const ra = a.ofType("session_ready").at(-1)!;
    const rb = b.ofType("session_ready").at(-1)!;
    expect(ra.sessionId).toBe("sess-1");
    expect(rb.sessionId).toBe("sess-1"); // shared session
    expect(ra.connectionId).not.toBe(rb.connectionId); // distinct connections
    // Exactly one session created for the two members.
    expect(
      h.api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/sessions"))
    ).toHaveLength(1);
  });

  it("returns no_capacity when the session is at its connection cap and no slot can open", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 2 });
    const a = await h.join("a");
    const b = await h.join("b");
    await h.send(a, { type: "claim" });
    h.api.failConnectionsWith(429, "connections_per_session");
    await h.send(b, { type: "claim" });
    expect(b.ofType("error").at(-1)).toMatchObject({ message: "no_capacity" });
  });
});

/** The `bind` list a `POST /tokens` call asked for, or undefined if unscoped. */
function bindOf(call: { body: unknown }): string[] | undefined {
  const details = (call.body as { authorization_details?: Array<Record<string, never>> })
    .authorization_details;
  return (details?.[0] as unknown as { resources?: { sessions?: { bind?: string[] } } } | undefined)
    ?.resources?.sessions?.bind;
}

/**
 * The `jwt-N` the mock hands back for each `POST /tokens`, paired with whether
 * that mint asked for a scope — the mock numbers tokens in call order.
 */
function mintedTokens(api: CoordinatorMock): Array<{ jwt: string; scoped: boolean }> {
  return api.callsTo("/tokens").map((call, i) => ({
    jwt: `jwt-${i + 1}`,
    scoped: (call.body as Record<string, unknown>).authorization_details !== undefined,
  }));
}

describe("session-scoped member tokens", () => {
  it("sends no token during grace, when there is no session to bind to yet", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1 });
    const a = await h.join("a");
    expect(a.ofType("token")).toHaveLength(0);
    expect(h.api.countTo("/tokens")).toBe(0);
  });

  it("binds the member's token to the session they claimed, before session_ready", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1, tokenTtlSeconds: 60 });
    const a = await h.join("a");
    await h.send(a, { type: "claim" });

    const sessionId = a.ofType("session_ready").at(-1)!.sessionId;
    const mint = h.api.callsTo("/tokens").at(-1)!;
    const body = mint.body as { expires_after: number; authorization_details: unknown };
    expect(body.expires_after).toBe(60);
    // No `constraints`: the limit resolves to the bound count, so the grant is
    // full on arrival and the token cannot open a session of its own.
    expect(body.authorization_details).toEqual([
      {
        type: "session",
        resources: { models: { match: ["helios"] }, sessions: { bind: [sessionId] } },
      },
    ]);

    const order = a.types();
    expect(order.indexOf("token")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("token")).toBeLessThan(order.indexOf("session_ready"));
  });

  it("gives members of one shared session distinct tokens", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 2 });
    const a = await h.join("a");
    const b = await h.join("b");
    await h.send(a, { type: "claim" });
    await h.send(b, { type: "claim" });

    const sessionId = a.ofType("session_ready").at(-1)!.sessionId;
    expect(b.ofType("session_ready").at(-1)!.sessionId).toBe(sessionId);
    expect(a.ofType("token").at(-1)!.jwt).not.toBe(b.ofType("token").at(-1)!.jwt);
    for (const mint of h.api.callsTo("/tokens").filter((c) => bindOf(c))) {
      expect(bindOf(mint)).toEqual([sessionId]);
    }
  });

  it("hands a member seated on an already-running slot their token at admission", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 2 });
    const a = await h.join("a");
    await h.send(a, { type: "claim" });
    const b = await h.join("b");

    expect(bindOf(h.api.callsTo("/tokens").at(-1)!)).toEqual([
      a.ofType("session_ready").at(-1)!.sessionId,
    ]);
    expect(b.ofType("token")).toHaveLength(1);
  });

  it("re-mints on request_token rather than re-delivering the same token", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1 });
    const a = await h.join("a");
    await h.send(a, { type: "claim" });
    const first = a.ofType("token").at(-1)!.jwt;

    const before = h.api.countTo("/tokens");
    await h.send(a, { type: "request_token" });
    expect(h.api.countTo("/tokens")).toBe(before + 1);
    expect(a.ofType("token").at(-1)!.jwt).not.toBe(first);
    expect(bindOf(h.api.callsTo("/tokens").at(-1)!)).toEqual([
      a.ofType("session_ready").at(-1)!.sessionId,
    ]);
  });

  it("binds a spilled member's token to the session they actually landed on", async () => {
    const h = makeHarness({ maxSessions: 2, usersPerSession: 2 });
    const a = await h.join("a");
    const b = await h.join("b"); // same slot as a
    await h.send(a, { type: "claim" });

    // b's connection mint on the shared session hits the cap once, spilling
    // b to a brand-new slot with its own session.
    h.api.failNextConnections(1, 429, "connections_per_session");
    await h.send(b, { type: "claim" });

    const sessionB = b.ofType("session_ready").at(-1)!.sessionId;
    expect(sessionB).not.toBe(a.ofType("session_ready").at(-1)!.sessionId);
    expect(bindOf(h.api.callsTo("/tokens").at(-1)!)).toEqual([sessionB]);
  });

  it("never authorizes a session or connection call with a member token", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 2 });
    const a = await h.join("a");
    const b = await h.join("b");
    await h.send(a, { type: "claim" });
    await h.send(b, { type: "claim" });

    const scoped = new Set(
      mintedTokens(h.api)
        .filter((t) => t.scoped)
        .map((t) => `Bearer ${t.jwt}`)
    );
    expect(scoped.size).toBeGreaterThan(0);
    const serverCalls = h.api.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/tokens"));
    expect(serverCalls.length).toBeGreaterThan(0);
    for (const call of serverCalls) {
      expect(scoped.has(call.headers["Authorization"]!)).toBe(false);
    }
  });

  it("binds a token for a slot persisted before this version", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 1 });
    // A slot written by an earlier version carries its own `jwt`; the session
    // it created belongs to the same API key, so it binds like any other.
    await h.room.storage.put("slot:legacy", {
      slotId: "legacy",
      sessionId: "sess-old",
      members: ["a"],
      createdAt: Date.now(),
      jwt: "stale-slot-jwt",
      jwtExpiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    await h.room.storage.put("member:a", {
      slotId: "legacy",
      sessionId: "sess-old",
      connectionId: 1,
      expiresAt: Date.now() + 60_000,
      warned: false,
      claimed: true,
    });
    const a = h.room.register(new FakeConnection("a"));
    await h.server.onMessage(JSON.stringify({ type: "request_token" }), a);

    expect(bindOf(h.api.callsTo("/tokens").at(-1)!)).toEqual(["sess-old"]);
    expect(a.ofType("token").at(-1)!.jwt).not.toBe("stale-slot-jwt");
  });

  it("keeps unscoped tokens when acquireSession sources sessions externally", async () => {
    const h = makeHarness({
      maxSessions: 1,
      acquireSession: async () => "external-1",
    });
    const a = await h.join("a");
    const mint = h.api.callsTo("/tokens").at(-1)!;
    expect((mint.body as Record<string, unknown>).authorization_details).toBeUndefined();
    await h.send(a, { type: "claim" });
    expect(a.ofType("session_ready").at(-1)!.sessionId).toBe("external-1");
  });
});

describe("token mint failure", () => {
  it("surfaces a token error when a member's mint fails", async () => {
    const h = makeHarness({ maxSessions: 1 });
    const a = await h.join("a");
    await h.send(a, { type: "claim" });
    h.api.failTokensWith(500, "down");
    await h.send(a, { type: "request_token" });
    expect(a.ofType("error").at(-1)).toMatchObject({ message: "token_mint_failed" });
  });

  it("still seats a member whose token mint fails, leaving getJwt to retry", async () => {
    const h = makeHarness({ maxSessions: 1, usersPerSession: 2 });
    const a = await h.join("a");
    await h.send(a, { type: "claim" }); // warms the server JWT and the session
    h.api.failTokensWith(500, "down");

    const b = await h.join("b");
    await h.send(b, { type: "claim" });
    expect(b.ofType("error").at(-1)).toMatchObject({ message: "token_mint_failed" });
    expect(b.ofType("session_ready").at(-1)!.sessionId).toBe(
      a.ofType("session_ready").at(-1)!.sessionId
    );
  });
});

describe("alarm scheduling", () => {
  it("sets an alarm while members exist and clears it once the room empties", async () => {
    const h = makeHarness({ maxSessions: 1 });
    const a = await h.join("a");
    expect(typeof h.room.storage.alarm).toBe("number");
    await h.close(a);
    await h.server.onAlarm();
    expect(h.room.storage.alarm).toBeNull();
  });
});

describe("custom session lifecycle overrides", () => {
  it("leases via acquireSession and notifies releaseSession instead of deleting", async () => {
    const released: Array<{ sessionId: string; lastMember: boolean }> = [];
    const h = makeHarness({
      maxSessions: 1,
      acquireSession: async () => "leased-9",
      releaseSession: async ({ sessionId, lastMember }) => {
        released.push({ sessionId, lastMember });
      },
    });
    const a = await h.join("a");
    await h.send(a, { type: "claim" });
    expect(a.ofType("session_ready").at(-1)!.sessionId).toBe("leased-9");
    // No POST /sessions create when acquisition is overridden.
    expect(
      h.api.calls.filter((c) => c.method === "POST" && c.url.endsWith("/sessions"))
    ).toHaveLength(0);

    await h.send(a, { type: "session_ended" });
    expect(released.at(-1)).toEqual({ sessionId: "leased-9", lastMember: true });
    // Custom release means no DELETE to the Coordinator.
    expect(h.api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("admin mode", () => {
  async function admin(h: Harness, id: string) {
    const conn = h.room.register(new FakeConnection(id));
    await h.server.onConnect(conn, makeContext({ admin: true }));
    return conn;
  }

  it("rejects admin connections when no password is configured", async () => {
    const h = makeHarness({});
    const conn = await admin(h, "admin-1");
    expect(conn.ofType("admin_rejected")[0]).toMatchObject({ reason: "admin_disabled" });
    expect(conn.closed).toBe(true);
  });

  it("rejects an invalid password", async () => {
    const h = makeHarness({ adminPassword: "secret" });
    const conn = await admin(h, "admin-1");
    await h.send(conn, { type: "admin_auth", password: "wrong" });
    expect(conn.ofType("admin_rejected")[0]).toMatchObject({ reason: "invalid_password" });
  });

  it("authenticates and pushes a snapshot, history, and live updates", async () => {
    const h = makeHarness({ adminPassword: "secret", maxSessions: 1 });
    const conn = await admin(h, "admin-1");
    await h.send(conn, { type: "admin_auth", password: "secret" });
    expect(conn.types()).toEqual(
      expect.arrayContaining(["admin_ready", "admin_snapshot", "admin_log_history"])
    );

    // A user joining the room pushes a fresh snapshot to the authed admin.
    const before = conn.ofType("admin_snapshot").length;
    await h.join("a");
    expect(conn.ofType("admin_snapshot").length).toBeGreaterThan(before);
  });

  it("kicks a waiting user out of the queue", async () => {
    const h = makeHarness({ adminPassword: "secret", maxSessions: 1 });
    await h.join("a"); // admitted
    const b = await h.join("b"); // queued
    const conn = await admin(h, "admin-1");
    await h.send(conn, { type: "admin_auth", password: "secret" });
    await h.send(conn, { type: "admin_kick_queued", connId: "b" });

    expect(conn.ofType("admin_action_result").at(-1)).toMatchObject({
      action: "kick_queued",
      ok: true,
    });
    expect(b.closed).toBe(true);
  });

  it("persists warn/error events to history but not high-frequency info events", async () => {
    const h = makeHarness({ adminPassword: "secret", maxSessions: 1 });
    h.api.failSessionsWith(500, "down"); // makes the claim log an error
    await h.send(await h.join("a"), { type: "claim" });

    const conn = await admin(h, "admin-1");
    await h.send(conn, { type: "admin_auth", password: "secret" });
    const history = conn.ofType("admin_log_history").at(-1)!.entries as Array<{
      level: string;
      event: string;
    }>;
    expect(history.some((e) => e.level === "error")).toBe(true);
    // `user_connected` is an info event and is streamed live but never stored.
    expect(history.some((e) => e.event === "user_connected")).toBe(false);
  });
});
