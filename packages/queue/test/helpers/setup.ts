// Node 25 unflagged the experimental Web Storage API: without the
// `--localstorage-file` flag, the global `localStorage` resolves to an object
// whose Storage methods are all undefined (Node 26 throws a DOMException on
// access instead), and it shadows the working localStorage that the jsdom test
// environment would otherwise provide. That makes the browser-side suites fail
// with "localStorage.clear is not a function" - the same quirk that
// src/client.ts guards against at runtime. On Node 22-24 the API is behind
// `--experimental-webstorage` and the global is undefined by default, so jsdom's
// real localStorage is kept.
//
// Feature-detect (rather than checking the Node version) and install a minimal
// in-memory Storage only when the global one isn't functional. CI pins Node 20
// and contributors on Node 25+ get a working polyfill, so `pnpm test` is green
// everywhere.

class MemoryStorage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function isFunctionalStorage(value: unknown): value is Storage {
  return (
    typeof (value as Storage | undefined)?.getItem === "function" &&
    typeof (value as Storage | undefined)?.setItem === "function" &&
    typeof (value as Storage | undefined)?.clear === "function"
  );
}

let existing: unknown;
try {
  existing = globalThis.localStorage;
} catch {
  existing = undefined;
}

if (!isFunctionalStorage(existing)) {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage() as unknown as Storage,
    configurable: true,
    writable: true,
  });
}
