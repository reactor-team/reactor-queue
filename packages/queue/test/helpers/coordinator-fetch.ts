/**
 * A programmable `fetch` double for the Reactor Coordinator REST surface the
 * queue's `CoordinatorClient` talks to: `POST /tokens`, `POST /sessions`,
 * `POST .../connections`, `GET .../runtime`, and `DELETE /sessions/{id}`.
 *
 * It returns realistic success bodies by default and lets a test force any
 * endpoint to fail (a quota 429 on session create, a connection-cap 429, a
 * terminal runtime state, …) while recording every call for assertions.
 */

import { vi } from "vitest";

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface CoordinatorMock {
  /** Every request made, oldest first. */
  calls: RecordedCall[];
  /** Calls whose URL contains the given fragment. */
  callsTo(fragment: string): RecordedCall[];
  countTo(fragment: string): number;
  /** Force `POST /sessions` to fail with this status/body until reset. */
  failSessionsWith(status: number, body?: string): void;
  /** Force `POST .../connections` to fail with this status/body until reset. */
  failConnectionsWith(status: number, body?: string): void;
  /** Fail only the next `n` `POST .../connections` calls, then succeed again. */
  failNextConnections(n: number, status: number, body?: string): void;
  /** Force `POST /tokens` to fail with this status/body until reset. */
  failTokensWith(status: number, body?: string): void;
  /** State returned by `GET .../runtime` (default "ACTIVE"). */
  runtimeState: string;
  /** Next connection id handed out by `POST .../connections`. */
  nextConnectionId: number;
}

interface Failure {
  status: number;
  body: string;
}

function jsonResponse(status: number, payload: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: `HTTP ${status}`,
    json: async () => payload,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  } as unknown as Response;
}

function textResponse(status: number, body: string): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: `HTTP ${status}`,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

/** Install the mock on `globalThis.fetch` (vitest restores it via clearMocks/restore). */
export function installCoordinatorFetch(): CoordinatorMock {
  const state = {
    calls: [] as RecordedCall[],
    runtimeState: "ACTIVE",
    nextConnectionId: 1,
    sessionSeq: 0,
    tokenSeq: 0,
    sessionFailure: null as Failure | null,
    connectionFailure: null as Failure | null,
    connectionFailuresLeft: 0,
    tokenFailure: null as Failure | null,
  };

  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = init?.body;
    let body: unknown = undefined;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = String(v);
    state.calls.push({ method, url, body, headers });

    if (method === "POST" && url.endsWith("/tokens")) {
      if (state.tokenFailure)
        return textResponse(state.tokenFailure.status, state.tokenFailure.body);
      state.tokenSeq += 1;
      return jsonResponse(200, {
        jwt: `jwt-${state.tokenSeq}`,
        expires_at: Math.floor(Date.now() / 1000) + 600,
      });
    }

    if (method === "POST" && url.endsWith("/connections")) {
      if (state.connectionFailure) {
        const failure = state.connectionFailure;
        // failuresLeft 0 means "fail forever"; a positive count burns down.
        if (state.connectionFailuresLeft > 0) {
          state.connectionFailuresLeft -= 1;
          if (state.connectionFailuresLeft === 0) state.connectionFailure = null;
        }
        return textResponse(failure.status, failure.body);
      }
      const id = state.nextConnectionId;
      state.nextConnectionId += 1;
      return jsonResponse(201, { connection_id: id });
    }

    if (method === "POST" && url.endsWith("/sessions")) {
      if (state.sessionFailure)
        return textResponse(state.sessionFailure.status, state.sessionFailure.body);
      state.sessionSeq += 1;
      return jsonResponse(201, { session_id: `sess-${state.sessionSeq}` });
    }

    if (method === "GET" && url.endsWith("/runtime")) {
      return jsonResponse(200, { state: state.runtimeState });
    }

    if (method === "DELETE" && /\/sessions\/[^/]+$/.test(url)) {
      return jsonResponse(200, {});
    }

    return jsonResponse(404, { error: "unmocked endpoint", url, method });
  };

  vi.stubGlobal("fetch", vi.fn(impl));

  return {
    calls: state.calls,
    callsTo: (fragment) => state.calls.filter((c) => c.url.includes(fragment)),
    countTo: (fragment) => state.calls.filter((c) => c.url.includes(fragment)).length,
    failSessionsWith: (status, b = "") => (state.sessionFailure = { status, body: b }),
    failConnectionsWith: (status, b = "") => {
      state.connectionFailure = { status, body: b };
      state.connectionFailuresLeft = 0;
    },
    failNextConnections: (n, status, b = "") => {
      state.connectionFailure = { status, body: b };
      state.connectionFailuresLeft = n;
    },
    failTokensWith: (status, b = "") => (state.tokenFailure = { status, body: b }),
    get runtimeState() {
      return state.runtimeState;
    },
    set runtimeState(v: string) {
      state.runtimeState = v;
    },
    get nextConnectionId() {
      return state.nextConnectionId;
    },
    set nextConnectionId(v: number) {
      state.nextConnectionId = v;
    },
  };
}
