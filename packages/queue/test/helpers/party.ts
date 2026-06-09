/**
 * In-memory doubles for the slice of the PartyKit server runtime the queue
 * uses: `room.storage` (get/put/delete/list/alarms), `room.getConnection`,
 * `room.env`, plus `Connection` and `ConnectionContext`. The queue imports
 * `partykit/server` only as types, so a structurally-compatible fake is enough
 * to drive `onConnect`/`onMessage`/`onClose`/`onAlarm` against real storage
 * semantics — including the lexicographically-ordered `list({ prefix, limit,
 * startAfter })` the FIFO queue and ring-buffer log depend on.
 */

import { CLIENT_ID_QUERY_KEY, ADMIN_MODE_QUERY_KEY } from "../../src/protocol";

interface ListOptions {
  prefix?: string;
  limit?: number;
  startAfter?: string;
  reverse?: boolean;
}

/**
 * Durable-Object storage backed by a Map. Values are structured-cloned on the
 * way in and out so a caller can never mutate a stored record by reference —
 * the same isolation the real serialized storage gives, which is what makes the
 * server's "re-read after every await" guards meaningful under test.
 */
export class FakeStorage {
  private readonly map = new Map<string, unknown>();
  /** Scheduled alarm timestamp (ms), or null when none is set. */
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.map.has(key)) return undefined;
    return structuredClone(this.map.get(key)) as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async list<T>(opts: ListOptions = {}): Promise<Map<string, T>> {
    let keys = [...this.map.keys()];
    if (opts.prefix !== undefined) keys = keys.filter((k) => k.startsWith(opts.prefix!));
    if (opts.startAfter !== undefined) keys = keys.filter((k) => k > opts.startAfter!);
    keys.sort();
    if (opts.reverse) keys.reverse();
    if (opts.limit !== undefined) keys = keys.slice(0, opts.limit);
    const out = new Map<string, T>();
    for (const k of keys) out.set(k, structuredClone(this.map.get(k)) as T);
    return out;
  }

  async setAlarm(ts: number): Promise<void> {
    this.alarm = ts;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  /** Test-only: raw key inspection without cloning. */
  rawKeys(): string[] {
    return [...this.map.keys()];
  }
}

/** A single browser/admin WebSocket connection. */
export class FakeConnection {
  readyState = 1; // OPEN
  closed = false;
  closeCode?: number;
  closeReason?: string;
  readonly sent: string[] = [];
  room?: FakeRoom;

  constructor(readonly id: string) {}

  send(data: string): void {
    // The server guards on readyState before calling send; mirror real WS by
    // dropping frames once closed so a stale reference can't "receive".
    if (this.readyState !== 1) return;
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3; // CLOSED
    // A closed connection is no longer discoverable via getConnection, matching
    // the platform reaping it.
    this.room?.connections.delete(this.id);
  }

  messages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  types(): string[] {
    return this.messages().map((m) => m.type as string);
  }

  last(): Record<string, unknown> | undefined {
    return this.messages().at(-1);
  }

  ofType(type: string): Array<Record<string, unknown>> {
    return this.messages().filter((m) => m.type === type);
  }
}

export class FakeRoom {
  readonly storage = new FakeStorage();
  readonly connections = new Map<string, FakeConnection>();

  constructor(readonly env: Record<string, unknown> = {}) {}

  getConnection(id: string): FakeConnection | undefined {
    return this.connections.get(id);
  }

  /** Register a live connection (as the platform does before `onConnect`). */
  register(conn: FakeConnection): FakeConnection {
    conn.room = this;
    this.connections.set(conn.id, conn);
    return conn;
  }
}

/** Build a `ConnectionContext` whose request URL carries the queue's query keys. */
export function makeContext(
  opts: { clientId?: string; admin?: boolean; origin?: string | null; host?: string } = {}
): { request: { url: string; headers: { get(name: string): string | null } } } {
  const host = opts.host ?? "queue.partykit.dev";
  const url = new URL(`https://${host}/parties/main/reactor-queue`);
  if (opts.admin) url.searchParams.set(ADMIN_MODE_QUERY_KEY, "1");
  if (opts.clientId !== undefined) url.searchParams.set(CLIENT_ID_QUERY_KEY, opts.clientId);
  const origin = opts.origin === undefined ? null : opts.origin;
  return {
    request: {
      url: url.toString(),
      headers: {
        get(name: string): string | null {
          return name.toLowerCase() === "origin" ? origin : null;
        },
      },
    },
  };
}
