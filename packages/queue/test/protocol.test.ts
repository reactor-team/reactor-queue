import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  DEFAULT_ROOM,
  PROTOCOL_VERSION,
  TERMINAL_SESSION_STATES,
  parseServerMessage,
  parseClientMessage,
  parseAdminClientMessage,
  parseAdminServerMessage,
} from "../src/protocol";

describe("protocol constants", () => {
  it("pins the wire defaults the client and server both rely on", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(DEFAULT_ROOM).toBe("reactor-queue");
    expect(DEFAULTS.maxSessions).toBe(1);
    expect(DEFAULTS.usersPerSession).toBe(1);
    expect(DEFAULTS.sessionDurationMs).toBe(120_000);
    expect(DEFAULTS.admissionGraceMs).toBe(45_000);
    expect(DEFAULTS.tokenTtlSeconds).toBe(60);
    expect(TERMINAL_SESSION_STATES).toEqual(["CLOSED", "INACTIVE"]);
  });
});

describe("parseServerMessage", () => {
  it("accepts any object carrying a string type", () => {
    const msg = parseServerMessage(JSON.stringify({ type: "admitted", active: 1 }));
    expect(msg).toEqual({ type: "admitted", active: 1 });
  });

  it("rejects malformed JSON", () => {
    expect(parseServerMessage("not json")).toBeNull();
  });

  it("rejects objects without a string type", () => {
    expect(parseServerMessage(JSON.stringify({ active: 1 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 7 }))).toBeNull();
  });
});

describe("parseClientMessage", () => {
  it("accepts queue client messages", () => {
    expect(parseClientMessage(JSON.stringify({ type: "claim" }))).toEqual({ type: "claim" });
  });

  it("refuses admin-namespaced types so an admin frame can't reach the queue path", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "admin_kick_member", connId: "x" }))
    ).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseClientMessage("{")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ foo: 1 }))).toBeNull();
  });
});

describe("parseAdminClientMessage", () => {
  it("only accepts admin-namespaced types", () => {
    expect(parseAdminClientMessage(JSON.stringify({ type: "admin_auth", password: "p" }))).toEqual({
      type: "admin_auth",
      password: "p",
    });
    expect(parseAdminClientMessage(JSON.stringify({ type: "claim" }))).toBeNull();
  });
});

describe("parseAdminServerMessage", () => {
  it("only accepts admin-namespaced types", () => {
    expect(parseAdminServerMessage(JSON.stringify({ type: "admin_ready" }))).toEqual({
      type: "admin_ready",
    });
    expect(parseAdminServerMessage(JSON.stringify({ type: "token", jwt: "x" }))).toBeNull();
    expect(parseAdminServerMessage("nope")).toBeNull();
  });
});
