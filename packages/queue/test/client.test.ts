import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Replace the real WebSocket transport with the in-memory fake before the
// client module (which imports it) is evaluated.
vi.mock("partysocket", () => import("./helpers/socket"));

import { ReactorQueueClient } from "../src/client";
import type { QueueState } from "../src/types";
import { lastSocket, resetSockets, sockets } from "./helpers/socket";

beforeEach(() => {
  resetSockets();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

function connected(overrides = {}) {
  const client = new ReactorQueueClient({ host: "queue.test", autoConnect: true, ...overrides });
  return { client, socket: lastSocket() };
}

describe("connection + identity", () => {
  it("starts idle and only opens a socket on connect", () => {
    const client = new ReactorQueueClient({ host: "queue.test" });
    expect(client.getState().phase).toBe("idle");
    expect(sockets).toHaveLength(0);
    client.connect();
    expect(client.getState().phase).toBe("connecting");
    expect(sockets).toHaveLength(1);
  });

  it("persists and reuses a generated client id across instances", () => {
    const a = new ReactorQueueClient({ host: "queue.test", autoConnect: true });
    const idA = (lastSocket().options.query as Record<string, string>).rqClientId;
    a.destroy();
    new ReactorQueueClient({ host: "queue.test", autoConnect: true });
    const idB = (lastSocket().options.query as Record<string, string>).rqClientId;
    expect(idA).toBe(idB);
  });
});

describe("inbound queue messages drive phase", () => {
  it("queue_position → queued with position fields", () => {
    const { client, socket } = connected();
    socket.emitMessage({ type: "queue_position", position: 3, total: 5, active: 1, capacity: 2 });
    const s = client.getState();
    expect(s.phase).toBe("queued");
    expect(s).toMatchObject({ position: 3, total: 5, active: 1, capacity: 2 });
  });

  it("admitted → admitted with a grace deadline and session budget", () => {
    const { client, socket } = connected();
    const before = Date.now();
    socket.emitMessage({
      type: "admitted",
      active: 1,
      capacity: 2,
      graceMs: 45_000,
      sessionDurationMs: 120_000,
    });
    const s = client.getState();
    expect(s.phase).toBe("admitted");
    expect(s.sessionDurationMs).toBe(120_000);
    expect(s.sessionEndsAt).toBeGreaterThanOrEqual(before + 45_000);
  });

  it("session_ready → active with sessionId + connectionId", () => {
    const { client, socket } = connected();
    socket.emitMessage({
      type: "session_ready",
      sessionId: "sess-1",
      connectionId: 9,
      sessionDurationMs: 120_000,
      expiresAt: Date.now() + 120_000,
    });
    const s = client.getState();
    expect(s.phase).toBe("active");
    expect(s.sessionId).toBe("sess-1");
    expect(s.connectionId).toBe(9);
  });

  it("time_warning sets secondsLeft without leaving active", () => {
    const { client, socket } = connected();
    socket.emitMessage({
      type: "session_ready",
      sessionId: "s",
      connectionId: 1,
      sessionDurationMs: 1,
      expiresAt: 1,
    });
    socket.emitMessage({ type: "time_warning", secondsLeft: 20, expiresAt: Date.now() + 20_000 });
    expect(client.getState().phase).toBe("active");
    expect(client.getState().secondsLeft).toBe(20);
  });

  it("ignores malformed frames", () => {
    const { client, socket } = connected();
    socket.emitRaw("}{ not json");
    expect(client.getState().phase).toBe("connecting");
  });
});

describe("terminal transitions", () => {
  it("expired clears the session, tears down the socket, and keeps the token", () => {
    const { client, socket } = connected();
    socket.emitMessage({
      type: "token",
      jwt: "jwt-1",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    socket.emitMessage({
      type: "session_ready",
      sessionId: "s",
      connectionId: 1,
      sessionDurationMs: 1,
      expiresAt: 1,
    });
    socket.emitMessage({ type: "expired", reason: "timeout" });
    const s = client.getState();
    expect(s.phase).toBe("expired");
    expect(s.sessionId).toBeNull();
    expect(s.reason).toBe("timeout");
    expect(s.token).toBe("jwt-1"); // short-lived JWT is kept for in-flight cleanup
    expect(socket.closed).toBe(true);
  });

  it("rejected schedules an automatic rejoin", () => {
    vi.useFakeTimers();
    const { client, socket } = connected({ retryRejectedMs: 3000 });
    socket.emitMessage({ type: "rejected", reason: "already_connected" });
    expect(client.getState().phase).toBe("rejected");
    expect(socket.closed).toBe(true);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(sockets).toHaveLength(2); // reconnected
  });

  it("disconnected when the socket drops mid-queue", () => {
    const { client, socket } = connected();
    socket.emitMessage({ type: "queue_position", position: 1, total: 1, active: 0, capacity: 1 });
    socket.emitClose();
    expect(client.getState().phase).toBe("disconnected");
  });
});

describe("getJwt resolver", () => {
  it("returns the cached token while it is fresh without a round-trip", async () => {
    const { client, socket } = connected();
    socket.emitMessage({
      type: "token",
      jwt: "fresh",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    await expect(client.getJwt()).resolves.toBe("fresh");
    expect(socket.sentTypes()).not.toContain("request_token");
  });

  it("requests a fresh token over the socket when none is cached", async () => {
    const { client, socket } = connected();
    const p = client.getJwt();
    expect(socket.sentTypes()).toContain("request_token");
    socket.emitMessage({
      type: "token",
      jwt: "minted",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    await expect(p).resolves.toBe("minted");
  });

  it("hands back the last token when the socket is gone (in-flight SDK cleanup)", async () => {
    const { client, socket } = connected();
    socket.emitMessage({
      type: "token",
      jwt: "stale",
      expiresAt: Math.floor(Date.now() / 1000) - 5,
    });
    socket.emitMessage({ type: "expired", reason: "timeout" }); // tears down socket, keeps token
    await expect(client.getJwt()).resolves.toBe("stale");
  });

  it("rejects when a token request times out", async () => {
    vi.useFakeTimers();
    const { client } = connected({ tokenRequestTimeoutMs: 1000 });
    const p = client.getJwt();
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe("actions", () => {
  it("claim moves admitted → starting and sends a claim", () => {
    const { client, socket } = connected();
    socket.emitMessage({
      type: "admitted",
      active: 1,
      capacity: 1,
      graceMs: 1000,
      sessionDurationMs: 1000,
    });
    client.claim();
    expect(socket.sentTypes()).toContain("claim");
    expect(client.getState().phase).toBe("starting");
  });

  it("leave sends a leave, tears down, and returns to idle", () => {
    const { client, socket } = connected();
    socket.emitMessage({ type: "queue_position", position: 1, total: 1, active: 0, capacity: 1 });
    client.leave();
    expect(socket.sentTypes()).toContain("leave");
    expect(socket.closed).toBe(true);
    expect(client.getState().phase).toBe("idle");
  });

  it("endSession from active returns to idle and drops the token", () => {
    const { client, socket } = connected();
    socket.emitMessage({ type: "token", jwt: "j", expiresAt: Math.floor(Date.now() / 1000) + 600 });
    socket.emitMessage({
      type: "session_ready",
      sessionId: "s",
      connectionId: 1,
      sessionDurationMs: 1,
      expiresAt: 1,
    });
    client.endSession();
    expect(socket.sentTypes()).toContain("session_ended");
    expect(client.getState().phase).toBe("idle");
    expect(client.getState().token).toBeNull();
    expect(client.getState().sessionId).toBeNull();
  });

  it("endSession after a terminal phase only clears session fields, leaving the phase", () => {
    const { client, socket } = connected();
    socket.emitMessage({ type: "expired", reason: "timeout" });
    client.endSession();
    expect(client.getState().phase).toBe("expired"); // untouched
    expect(client.getState().sessionId).toBeNull();
  });

  it("rejoin reconnects", () => {
    const { client, socket } = connected();
    socket.emitMessage({ type: "expired", reason: "timeout" });
    expect(sockets).toHaveLength(1);
    client.rejoin();
    expect(sockets).toHaveLength(2);
    expect(client.getState().phase).toBe("connecting");
  });
});

describe("subscription", () => {
  it("emits the current state immediately and on every change, then stops after unsubscribe", () => {
    const { client, socket } = connected();
    const seen: QueueState[] = [];
    const unsub = client.subscribe((s) => seen.push(s));
    expect(seen).toHaveLength(1); // immediate
    socket.emitMessage({ type: "queue_position", position: 1, total: 1, active: 0, capacity: 1 });
    expect(seen).toHaveLength(2);
    unsub();
    socket.emitMessage({ type: "queue_position", position: 1, total: 2, active: 0, capacity: 1 });
    expect(seen).toHaveLength(2); // no further emissions
  });
});

describe("error message", () => {
  it("records the reason and fails an in-flight token request", async () => {
    const { client, socket } = connected();
    const p = client.getJwt();
    socket.emitMessage({ type: "error", message: "token_mint_failed" });
    await expect(p).rejects.toThrow(/token_mint_failed/);
    expect(client.getState().reason).toBe("token_mint_failed");
  });
});
