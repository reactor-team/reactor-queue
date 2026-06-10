/**
 * In-memory stand-in for the `partysocket` default export. The browser clients
 * (`ReactorQueueClient`, `ReactorQueueAdminClient`) only use a small slice of a
 * WebSocket: `addEventListener` for `open`/`message`/`close`, `send`, `close`,
 * and `readyState`. This fake records sent frames and lets a test drive inbound
 * events deterministically, with no real socket.
 *
 * Tests install it with `vi.mock("partysocket", () => import("./helpers/socket"))`
 * and read the constructed instances from the shared `sockets` registry.
 */

type Listener = { cb: (event: unknown) => void; once: boolean };

/** Every socket constructed since the last {@link resetSockets}, in order. */
export const sockets: FakePartySocket[] = [];

export function resetSockets(): void {
  sockets.length = 0;
}

/** The most recently constructed socket (the one a fresh `connect()` made). */
export function lastSocket(): FakePartySocket {
  const s = sockets[sockets.length - 1];
  if (!s) throw new Error("no socket has been constructed");
  return s;
}

export class FakePartySocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  /** Mirrors `WebSocket.readyState`; OPEN so `send()` is allowed by default. */
  readyState = FakePartySocket.OPEN;
  /** Raw JSON frames passed to `send()`, oldest first. */
  readonly sent: string[] = [];
  readonly options: Record<string, unknown>;
  closed = false;

  private readonly listeners = new Map<string, Listener[]>();

  constructor(options: Record<string, unknown>) {
    this.options = options;
    sockets.push(this);
  }

  addEventListener(type: string, cb: (event: unknown) => void, opts?: { once?: boolean }): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ cb, once: opts?.once ?? false });
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /**
   * Real `partysocket.close()` resolves asynchronously and the client drops its
   * reference immediately, so we do not auto-fire a `close` event here. Tests
   * simulate a network/server close explicitly via {@link emitClose}.
   */
  close(): void {
    this.closed = true;
    this.readyState = FakePartySocket.CLOSED;
  }

  // ── test drivers ──────────────────────────────────────────────────────────

  emit(type: string, event: unknown): void {
    const list = this.listeners.get(type);
    if (!list) return;
    // Snapshot first: a once-listener mutates the array as it fires.
    for (const entry of [...list]) {
      entry.cb(event);
      if (entry.once) {
        const live = this.listeners.get(type);
        if (live)
          this.listeners.set(
            type,
            live.filter((l) => l !== entry)
          );
      }
    }
  }

  emitOpen(): void {
    this.readyState = FakePartySocket.OPEN;
    this.emit("open", {});
  }

  /** Deliver a server→client message (object is JSON-encoded like the wire). */
  emitMessage(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  /** Deliver a raw (already-encoded, possibly malformed) message frame. */
  emitRaw(data: string): void {
    this.emit("message", { data });
  }

  emitClose(): void {
    this.readyState = FakePartySocket.CLOSED;
    this.emit("close", {});
  }

  /** Parsed view of everything the client sent, oldest first. */
  sentMessages(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  /** The `type` field of each sent message, in order. */
  sentTypes(): string[] {
    return this.sentMessages().map((m) => m.type as string);
  }
}

// `vi.mock("partysocket", () => import("./helpers/socket"))` uses the default.
export default FakePartySocket;
