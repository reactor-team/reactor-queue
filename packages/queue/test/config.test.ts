import { describe, it, expect } from "vitest";
import { resolveConfig } from "../src/server/config";

const base = { apiKey: "rk_test", model: "helios" };

describe("resolveConfig — required values", () => {
  it("throws when no API key is given (config or env)", () => {
    expect(() => resolveConfig({ model: "helios" }, {})).toThrow(/No Reactor API key/);
  });

  it("throws when no model is given", () => {
    expect(() => resolveConfig({ apiKey: "rk_test" }, {})).toThrow(/No model configured/);
  });

  it("reads the API key and model from env when absent from config", () => {
    const c = resolveConfig({}, { RQ_REACTOR_API_KEY: "rk_env", RQ_MODEL: "lingbot" });
    expect(c.apiKey).toBe("rk_env");
    expect(c.model).toBe("lingbot");
  });
});

describe("resolveConfig — defaults", () => {
  it("applies the documented defaults", () => {
    const c = resolveConfig(base, {});
    expect(c.maxSessions).toBe(1);
    expect(c.usersPerSession).toBe(1);
    expect(c.capacity).toBe(1);
    expect(c.sessionDurationMs).toBe(120_000);
    expect(c.admissionGraceMs).toBe(45_000);
    expect(c.warningBeforeMs).toBe(30_000);
    expect(c.tokenTtlSeconds).toBe(60);
    expect(c.pollIntervalMs).toBe(15_000);
    expect(c.webrtcVersion).toBe("1.0");
    expect(c.apiVersion).toBe(1);
    expect(c.coordinatorUrl).toBe("https://api.reactor.inc");
    expect(c.stopSessionsOnExpiry).toBe(true);
    expect(c.allowDuplicateConnections).toBe(false);
    expect(c.startTimerOnSessionStart).toBe(false);
    expect(c.adminPassword).toBeNull();
    expect(c.allowedOrigins).toEqual([]);
    expect(c.acquireSession).toBeNull();
    expect(c.releaseSession).toBeNull();
  });

  it("computes capacity as maxSessions × usersPerSession", () => {
    const c = resolveConfig({ ...base, maxSessions: 3, usersPerSession: 4 }, {});
    expect(c.capacity).toBe(12);
  });
});

describe("resolveConfig — precedence (default → config → env)", () => {
  it("lets config override defaults", () => {
    const c = resolveConfig({ ...base, maxSessions: 5, sessionDurationMs: 60_000 }, {});
    expect(c.maxSessions).toBe(5);
    expect(c.sessionDurationMs).toBe(60_000);
  });

  it("lets env override config", () => {
    const c = resolveConfig(
      { ...base, maxSessions: 5, coordinatorUrl: "https://from-config" },
      { RQ_MAX_SESSIONS: "9", RQ_COORDINATOR_URL: "https://from-env" }
    );
    expect(c.maxSessions).toBe(9);
    expect(c.coordinatorUrl).toBe("https://from-env");
  });
});

describe("resolveConfig — numeric parsing (pickNum ignores non-positive)", () => {
  it("falls back to the default when config supplies a non-positive number", () => {
    const c = resolveConfig({ ...base, maxSessions: 0 }, {});
    expect(c.maxSessions).toBe(1);
  });

  it("ignores a non-positive env override and keeps the config value", () => {
    const c = resolveConfig({ ...base, maxSessions: 4 }, { RQ_MAX_SESSIONS: "-2" });
    expect(c.maxSessions).toBe(4);
  });

  it("ignores a non-numeric env value", () => {
    const c = resolveConfig(
      { ...base, sessionDurationMs: 30_000 },
      { RQ_SESSION_DURATION_MS: "abc" }
    );
    expect(c.sessionDurationMs).toBe(30_000);
  });
});

describe("resolveConfig — booleans", () => {
  it("parses true / 1 / yes as true", () => {
    for (const v of ["true", "1", "yes", "TRUE", "Yes"]) {
      expect(
        resolveConfig(base, { RQ_ALLOW_DUPLICATE_CONNECTIONS: v }).allowDuplicateConnections
      ).toBe(true);
    }
  });

  it("parses anything else as false", () => {
    expect(
      resolveConfig(base, { RQ_ALLOW_DUPLICATE_CONNECTIONS: "no" }).allowDuplicateConnections
    ).toBe(false);
  });

  it("env false overrides a config-true for stopSessionsOnExpiry", () => {
    const c = resolveConfig({ ...base, stopSessionsOnExpiry: true }, { RQ_STOP_SESSIONS: "false" });
    expect(c.stopSessionsOnExpiry).toBe(false);
  });

  it("resolves startTimerOnSessionStart from config and env", () => {
    expect(
      resolveConfig({ ...base, startTimerOnSessionStart: true }, {}).startTimerOnSessionStart
    ).toBe(true);
    expect(
      resolveConfig(
        { ...base, startTimerOnSessionStart: true },
        { RQ_START_TIMER_ON_SESSION_START: "false" }
      ).startTimerOnSessionStart
    ).toBe(false);
  });
});

describe("resolveConfig — allowedOrigins list", () => {
  it("splits, trims, and drops empty entries", () => {
    const c = resolveConfig(base, {
      RQ_ALLOWED_ORIGINS: " https://a.com , https://b.com ,, ",
    });
    expect(c.allowedOrigins).toEqual(["https://a.com", "https://b.com"]);
  });

  it("an all-empty list falls through to the config value", () => {
    const c = resolveConfig(
      { ...base, allowedOrigins: ["https://c.com"] },
      { RQ_ALLOWED_ORIGINS: " , " }
    );
    expect(c.allowedOrigins).toEqual(["https://c.com"]);
  });
});

describe("resolveConfig — coordinator URL normalization", () => {
  it("strips trailing slashes", () => {
    expect(
      resolveConfig({ ...base, coordinatorUrl: "https://api.reactor.inc//" }, {}).coordinatorUrl
    ).toBe("https://api.reactor.inc");
  });
});

describe("resolveConfig — passthrough overrides + hooks", () => {
  it("keeps custom acquire/release functions and hooks", () => {
    const acquireSession = async () => "sess-x";
    const releaseSession = async () => {};
    const hooks = { onError: () => {} };
    const c = resolveConfig({ ...base, acquireSession, releaseSession, hooks }, {});
    expect(c.acquireSession).toBe(acquireSession);
    expect(c.releaseSession).toBe(releaseSession);
    expect(c.hooks).toBe(hooks);
  });

  it("reads adminPassword from env over config", () => {
    expect(
      resolveConfig({ ...base, adminPassword: "code" }, { RQ_ADMIN_PASSWORD: "env" }).adminPassword
    ).toBe("env");
  });
});
