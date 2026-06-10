import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("partysocket", () => import("./helpers/socket"));

import { ReactorQueueAdminClient } from "../src/admin-client";
import { MAX_CLIENT_LOGS } from "../src/admin-types";
import type { AdminLogEntry, AdminSnapshotMessage } from "../src/protocol";
import { lastSocket, resetSockets } from "./helpers/socket";

beforeEach(() => {
  resetSockets();
});

function admin(overrides = {}) {
  const client = new ReactorQueueAdminClient({
    host: "queue.test",
    password: "secret",
    autoConnect: true,
    ...overrides,
  });
  return { client, socket: lastSocket() };
}

/** Let the async `authenticate()` resolve its password and send the frame. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

const snapshot = (over: Partial<AdminSnapshotMessage> = {}): AdminSnapshotMessage => ({
  type: "admin_snapshot",
  at: Date.now(),
  activeCount: 0,
  sessionCount: 0,
  config: {} as AdminSnapshotMessage["config"],
  queue: [],
  sessions: [],
  members: [],
  ...over,
});

const logEntry = (id: string): AdminLogEntry => ({
  id,
  at: Date.now(),
  level: "info",
  event: "user_connected",
  message: "m",
});

describe("admin connection + auth", () => {
  it("opens an admin-mode socket and authenticates on open with a string password", async () => {
    const { socket } = admin();
    expect((socket.options.query as Record<string, string>).rqAdmin).toBe("1");
    socket.emitOpen();
    await flush();
    expect(socket.sentMessages()[0]).toEqual({ type: "admin_auth", password: "secret" });
  });

  it("resolves a function password source", async () => {
    const { socket } = admin({ password: () => Promise.resolve("from-fn") });
    socket.emitOpen();
    await flush();
    expect(socket.sentMessages()[0]).toEqual({ type: "admin_auth", password: "from-fn" });
  });

  it("goes to rejected when the password source throws", async () => {
    const { client, socket } = admin({
      password: () => {
        throw new Error("no creds");
      },
    });
    socket.emitOpen();
    await flush();
    expect(client.getState().phase).toBe("rejected");
    expect(client.getState().reason).toBe("no creds");
  });
});

describe("admin inbound messages", () => {
  it("admin_ready → ready", () => {
    const { client, socket } = admin();
    socket.emitMessage({ type: "admin_ready" });
    expect(client.getState().phase).toBe("ready");
  });

  it("admin_snapshot stores the snapshot", () => {
    const { client, socket } = admin();
    socket.emitMessage(snapshot({ activeCount: 4 }));
    expect(client.getState().snapshot?.activeCount).toBe(4);
  });

  it("admin_rejected tears the socket down", () => {
    const { client, socket } = admin();
    socket.emitMessage({ type: "admin_rejected", reason: "invalid_password" });
    expect(client.getState().phase).toBe("rejected");
    expect(client.getState().reason).toBe("invalid_password");
    expect(socket.closed).toBe(true);
  });

  it("admin_action_result is exposed as lastAction", () => {
    const { client, socket } = admin();
    socket.emitMessage({ type: "admin_action_result", action: "kick_member", ok: true });
    expect(client.getState().lastAction).toEqual({
      type: "admin_action_result",
      action: "kick_member",
      ok: true,
    });
  });
});

describe("admin activity log", () => {
  it("seeds from history then appends live entries", () => {
    const { client, socket } = admin();
    socket.emitMessage({ type: "admin_log_history", entries: [logEntry("a"), logEntry("b")] });
    socket.emitMessage({ type: "admin_log", entry: logEntry("c") });
    expect(client.getState().logs.map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("caps the client-side log buffer at MAX_CLIENT_LOGS, keeping the newest", () => {
    const { client, socket } = admin();
    const history = Array.from({ length: MAX_CLIENT_LOGS }, (_, i) => logEntry(`h${i}`));
    socket.emitMessage({ type: "admin_log_history", entries: history });
    socket.emitMessage({ type: "admin_log", entry: logEntry("newest") });
    const logs = client.getState().logs;
    expect(logs).toHaveLength(MAX_CLIENT_LOGS);
    expect(logs.at(-1)!.id).toBe("newest");
    expect(logs.find((l) => l.id === "h0")).toBeUndefined(); // oldest dropped
  });
});

describe("admin actions send the right frames", () => {
  it("kickMember / kickQueued / closeSession / refresh", () => {
    const { client, socket } = admin();
    socket.emitMessage({ type: "admin_ready" });
    client.kickMember("c1");
    client.kickQueued("c2");
    client.closeSession("sess-1");
    client.refresh();
    expect(socket.sentMessages()).toEqual([
      { type: "admin_kick_member", connId: "c1" },
      { type: "admin_kick_queued", connId: "c2" },
      { type: "admin_close_session", sessionId: "sess-1" },
      { type: "admin_refresh" },
    ]);
  });
});

describe("admin polling + disconnect", () => {
  it("polls a refresh on an interval once ready", () => {
    vi.useFakeTimers();
    const { socket } = admin({ refreshIntervalMs: 5000 });
    socket.emitMessage({ type: "admin_ready" });
    vi.advanceTimersByTime(10_000);
    const refreshes = socket.sentTypes().filter((t) => t === "admin_refresh");
    expect(refreshes.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it("disconnect returns to idle", () => {
    const { client, socket } = admin();
    client.disconnect();
    expect(client.getState().phase).toBe("idle");
    expect(socket.closed).toBe(true);
  });
});
