import { describe, it, expect, vi, afterEach } from "vitest";
import { CoordinatorClient, CoordinatorError } from "../src/server/coordinator";

const opts = {
  baseUrl: "https://coord.test",
  apiKey: "rk_test",
  apiVersion: 1,
  webrtcVersion: "1.0",
};

/** Stub global fetch with a queue of canned responses (consumed in order). */
function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const ok = r.status >= 200 && r.status < 300;
    return {
      ok,
      status: r.status,
      statusText: `HTTP ${r.status}`,
      json: async () => r.body,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CoordinatorClient.mintToken", () => {
  it("posts the API key + version headers and floors expires_after", async () => {
    const { calls } = stubFetch([{ status: 200, body: { jwt: "abc", expires_at: 123 } }]);
    const client = new CoordinatorClient(opts);
    const res = await client.mintToken(60.7);
    expect(res).toEqual({ jwt: "abc", expiresAt: 123 });

    const { url, init } = calls[0]!;
    expect(url).toBe("https://coord.test/tokens");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Reactor-API-Key"]).toBe("rk_test");
    expect(headers["Reactor-API-Version"]).toBe("1");
    expect(JSON.parse(init.body as string)).toEqual({ expires_after: 60 });
  });

  it("falls back to a `token` field and derives expiresAt when absent", async () => {
    stubFetch([{ status: 200, body: { token: "legacy" } }]);
    const before = Math.floor(Date.now() / 1000);
    const res = await new CoordinatorClient(opts).mintToken(60);
    expect(res.jwt).toBe("legacy");
    expect(res.expiresAt).toBeGreaterThanOrEqual(before + 60);
  });

  it("throws a CoordinatorError carrying endpoint, status, and body", async () => {
    stubFetch([{ status: 403, body: "expired key" }]);
    const err = await new CoordinatorClient(opts).mintToken(60).catch((e) => e);
    expect(err).toBeInstanceOf(CoordinatorError);
    expect(err.endpoint).toBe("POST /tokens");
    expect(err.status).toBe(403);
    expect(err.body).toBe("expired key");
  });
});

describe("CoordinatorClient server-JWT caching", () => {
  it("reuses a long-lived server JWT across calls (one /tokens mint)", async () => {
    const { calls } = stubFetch([
      { status: 200, body: { jwt: "server-jwt", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 201, body: { session_id: "sess-1" } },
      { status: 201, body: { session_id: "sess-2" } },
    ]);
    const client = new CoordinatorClient(opts);
    await client.createSession({ model: "helios", webrtcVersion: "1.0" });
    await client.createSession({ model: "helios", webrtcVersion: "1.0" });
    expect(calls.filter((c) => c.url.endsWith("/tokens"))).toHaveLength(1);
  });

  it("re-mints when the cached server JWT is within the skew window", async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 5; // < 30s skew
    const { calls } = stubFetch([
      { status: 200, body: { jwt: "jwt-a", expires_at: nearExpiry } },
      { status: 201, body: { session_id: "sess-1" } },
      { status: 200, body: { jwt: "jwt-b", expires_at: nearExpiry } },
      { status: 201, body: { session_id: "sess-2" } },
    ]);
    const client = new CoordinatorClient(opts);
    await client.createSession({ model: "helios", webrtcVersion: "1.0" });
    await client.createSession({ model: "helios", webrtcVersion: "1.0" });
    expect(calls.filter((c) => c.url.endsWith("/tokens"))).toHaveLength(2);
  });
});

describe("CoordinatorClient.getSessionState", () => {
  it("maps a 404 to CLOSED", async () => {
    stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 404, body: "" },
    ]);
    expect(await new CoordinatorClient(opts).getSessionState("sess-1")).toBe("CLOSED");
  });

  it("returns the reported state on success", async () => {
    stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 200, body: { state: "ACTIVE" } },
    ]);
    expect(await new CoordinatorClient(opts).getSessionState("sess-1")).toBe("ACTIVE");
  });

  it("returns null on a non-404 error so a transient blip won't free a slot", async () => {
    stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 500, body: "boom" },
    ]);
    expect(await new CoordinatorClient(opts).getSessionState("sess-1")).toBeNull();
  });

  it("returns null when even the JWT mint fails", async () => {
    stubFetch([{ status: 500, body: "no token" }]);
    expect(await new CoordinatorClient(opts).getSessionState("sess-1")).toBeNull();
  });
});

describe("CoordinatorClient.isTerminal", () => {
  it("is true only for CLOSED / INACTIVE", () => {
    expect(CoordinatorClient.isTerminal("CLOSED")).toBe(true);
    expect(CoordinatorClient.isTerminal("INACTIVE")).toBe(true);
    expect(CoordinatorClient.isTerminal("ACTIVE")).toBe(false);
    expect(CoordinatorClient.isTerminal(null)).toBe(false);
  });
});

describe("CoordinatorClient.createSession", () => {
  it("sends the model + transports body and returns the session id", async () => {
    const { calls } = stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 201, body: { session_id: "sess-42" } },
    ]);
    const id = await new CoordinatorClient(opts).createSession({
      model: "helios",
      webrtcVersion: "1.0",
    });
    expect(id).toBe("sess-42");
    const create = calls.find((c) => c.url.endsWith("/sessions"))!;
    const body = JSON.parse(create.init.body as string);
    expect(body.model).toEqual({ name: "helios" });
    expect(body.supported_transports).toEqual([{ protocol: "webrtc", version: "1.0" }]);
  });

  it("throws when the response has no session_id", async () => {
    stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 201, body: {} },
    ]);
    await expect(
      new CoordinatorClient(opts).createSession({ model: "helios", webrtcVersion: "1.0" })
    ).rejects.toThrow(/no session_id/);
  });

  it("surfaces a quota rejection as a CoordinatorError", async () => {
    stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 429, body: '{"error":"quota_exceeded"}' },
    ]);
    const err = await new CoordinatorClient(opts)
      .createSession({ model: "helios", webrtcVersion: "1.0" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CoordinatorError);
    expect(err.status).toBe(429);
    expect(err.endpoint).toBe("POST /sessions");
  });
});

describe("CoordinatorClient.createConnection", () => {
  it("returns the server-minted numeric connection id with the WebRTC header", async () => {
    const { calls } = stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 201, body: { connection_id: 7 } },
    ]);
    const id = await new CoordinatorClient(opts).createConnection("sess-1");
    expect(id).toBe(7);
    const mint = calls.find((c) => c.url.endsWith("/connections"))!;
    expect(mint.url).toBe("https://coord.test/sessions/sess-1/transport/webrtc/connections");
    expect((mint.init.headers as Record<string, string>)["Reactor-WebRTC-Version"]).toBe("1.0");
  });

  it("raises a 429 CoordinatorError when the session is at its connection cap", async () => {
    stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 429, body: "connections_per_session" },
    ]);
    const err = await new CoordinatorClient(opts).createConnection("sess-1").catch((e) => e);
    expect(err).toBeInstanceOf(CoordinatorError);
    expect(err.status).toBe(429);
  });

  it("throws when connection_id is not a number", async () => {
    stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 201, body: { connection_id: "nope" } },
    ]);
    await expect(new CoordinatorClient(opts).createConnection("sess-1")).rejects.toThrow(
      /no connection_id/
    );
  });
});

describe("CoordinatorClient.stopSession", () => {
  it("swallows a 404 (already gone)", async () => {
    stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 404, body: "" },
    ]);
    await expect(new CoordinatorClient(opts).stopSession("sess-1")).resolves.toBeUndefined();
  });

  it("sends the reason and throws on a real error", async () => {
    const { calls } = stubFetch([
      { status: 200, body: { jwt: "j", expires_at: Math.floor(Date.now() / 1000) + 600 } },
      { status: 500, body: "boom" },
    ]);
    const err = await new CoordinatorClient(opts).stopSession("sess-1", "because").catch((e) => e);
    expect(err).toBeInstanceOf(CoordinatorError);
    const del = calls.find((c) => c.init.method === "DELETE")!;
    expect(JSON.parse(del.init.body as string)).toEqual({ reason: "because" });
  });
});
