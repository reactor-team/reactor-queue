# `@reactor-team/queue`

> Drop-in waiting room for [Reactor](https://reactor.inc) demos.
> A PartyKit server + a JS/React client that admit users one slot at a time,
> hand each admitted user a **short-lived Reactor JWT**, cap how long they can
> stay, and slide the line forward the instant someone leaves.

This library puts a virtual queue in front of a Reactor model so only `N` people
are ever live at once — everyone else waits in an orderly line and is admitted
automatically as slots free up. It is a thin, customizable utility built **on
top of** the existing Reactor REST API; it does not replace or fork anything.

## Why this exists

**Reactor does not gate demand for you.** The platform hands out sessions on
request up to your account's quota; it has no built-in, dynamic waiting room
that holds users back and lets them in as capacity frees. Each live session
also occupies a GPU for its entire duration, so concurrency is a hard,
finite resource. Without something in front, a burst of traffic simply hits the
ceiling and users get errors — there is no graceful "you're next" path. This
library is that missing layer.

Three concrete reasons teams reach for it:

- **It makes a demo feel alive.** A visible line ("you're #42, ~6 min") signals
  that the thing is real, in-demand, and worth waiting for. Used in the right
  measure, scarcity is a feature — it turns a launch into an event and can help
  drive word-of-mouth instead of a flat "try it" button that quietly 429s under
  load.
- **It protects a hard capacity ceiling.** During a viral moment, uncapped
  traffic exhausts GPU capacity and *everyone's* experience breaks. A queue
  keeps exactly `N` sessions live and time-boxes each turn, so the system stays
  healthy and the wait stays predictable instead of degrading for all.
- **It right-sizes demos for scarce or new models.** Private or early-access
  models (e.g. a model partner's launch) often run on very limited capacity.
  Set `maxConcurrent` to sit just under the model's known ceiling and the demo
  runs smoothly within its means — no overcommit, no thrash — while still
  giving every visitor a fair, automatic turn.

## Who it's for

This is **not** an internal-only Reactor tool. It's for anyone building on
Reactor who needs to meter live access to a model:

- **Reactor API-platform users** — any developer who wants to add a waiting
  room to their own Reactor-powered app or demo.
- **Reactor's own demos** — gating first-party launches and public showcases.
- **Reactor model partners** launching private/early-access demos *with* Reactor
  (e.g. Overworld and similar) — capping a small-capacity model to a safe number
  of concurrent users while still letting a crowd line up.

---

## Mental model

```
   Browser (your app)                    PartyKit room (you deploy)            Reactor Coordinator
 ┌─────────────────────┐  WebSocket   ┌────────────────────────────┐  REST   ┌────────────────────┐
 │ @reactor-team/queue  │◀───────────▶│ @reactor-team/queue-server  │────────▶│ POST /tokens        │
 │  • partysocket       │   queue +   │  • FIFO queue + N-slot gate │         │ GET  /sessions/{id} │
 │  • getJwt() resolver │   tokens    │  • mints 60s Reactor JWTs   │         │ DELETE /sessions/{id}│
 │  • zustand store     │             │  • per-user session timer   │         └────────────────────┘
 └──────────┬──────────┘             │  • stops + reaps sessions   │
            │                         └────────────────────────────┘
            │ getJwt + sessionId
            ▼
   @reactor-team/js-sdk  ───────────────────── WebRTC ─────────────────────▶  GPU / model
```

The queue server is the **single source of truth**. It:

1. Lines users up FIFO and admits the head whenever `active < maxConcurrent`.
2. **Mints the Reactor JWT itself** (it holds the API key as a secret) and sends
   it only to admitted users — _the queue returns the JWT_.
3. Issues **very short-lived tokens** (default 60s). The client refreshes them
   on demand over the WebSocket via a `request_token` command, exposed as a
   standard `getJwt` resolver for the Reactor SDK.
4. Gives each admitted user a **bounded session** (default 120s). When time runs
   out the server calls `DELETE /sessions/{id}` to actually stop the GPU
   session — not just hide the UI.
5. Frees a slot the instant a user leaves: via an explicit `session_ended`
   message, a raw socket close (closed tab), **or** a periodic poll of the
   tracked session state that catches drop-outs whose notification never
   arrived.

## Packages

| Package | What it is | You install it… |
|---|---|---|
| [`@reactor-team/queue`](./packages/client) | Client: framework-agnostic `ReactorQueueClient` + React/zustand layer (`./react`) | in your web app |
| [`@reactor-team/queue-server`](./packages/server) | The PartyKit `Server` factory | in your PartyKit project |
| [`@reactor-team/queue-protocol`](./packages/protocol) | Shared wire types + defaults (transitive) | automatically |

---

## Quickstart

### 1. Stand up the server (PartyKit)

```ts
// partykit/server.ts
import { createReactorQueueServer } from "@reactor-team/queue-server";

export default createReactorQueueServer({ maxConcurrent: 3 });
```

```jsonc
// partykit.json
{
  "name": "my-demo-queue",
  "main": "partykit/server.ts",
  "compatibilityDate": "2024-11-01",
  "vars": { "RQ_SESSION_DURATION_MS": "120000" }
}
```

```bash
# local — put RQ_REACTOR_API_KEY in a .env file; `partykit dev` auto-loads it
echo "RQ_REACTOR_API_KEY=rk_your_key_here" >> .env
npx partykit dev

# deploy — push the secret from .env with --with-vars
npx partykit deploy --with-vars
# (or store it in PartyKit once: `npx partykit env add RQ_REACTOR_API_KEY`, then `npx partykit deploy`)
```

The API key lives only on the server. It is **never** shipped to the browser —
the browser only ever sees short-lived JWTs minted from it. (`.env` is loaded
automatically by `partykit dev`; for deploy it's only uploaded with
`--with-vars`.)

### 2. Gate your app (React)

```tsx
import { ReactorQueueProvider, useReactorQueue } from "@reactor-team/queue/react";
import { ReactorProvider, useReactor } from "@reactor-team/js-sdk";

export default function App() {
  return (
    <ReactorQueueProvider host={process.env.NEXT_PUBLIC_PARTYKIT_HOST!}>
      <Gate />
    </ReactorQueueProvider>
  );
}

function Gate() {
  const q = useReactorQueue();
  if (q.phase === "queued")   return <p>Position {q.position} of {q.total}</p>;
  if (q.phase === "admitted") return <button onClick={q.claim}>Enter</button>;
  if (q.phase === "expired")  return <button onClick={q.rejoin}>Rejoin</button>;
  if (q.phase !== "active")   return null;

  return (
    <ReactorProvider modelName="lingbot" getJwt={q.getJwt} connectOptions={{ autoConnect: true }}>
      <SessionBridge />
      {/* your model UI */}
    </ReactorProvider>
  );
}

// Report the session id back so the server can time-limit & reap it.
function SessionBridge() {
  const { reportSession, endSession } = useReactorQueue();
  const sessionId = useReactor((s) => s.sessionId);
  React.useEffect(() => { if (sessionId) reportSession(sessionId); }, [sessionId]);
  React.useEffect(() => () => endSession(), []);
  return null;
}
```

See [`examples/basic`](./examples/basic) for the complete, runnable version
(one page, base SDK, its own PartyKit room) — `app/page.tsx` is the whole thing.

### Vanilla JS (no React)

```ts
import { ReactorQueueClient } from "@reactor-team/queue";
import { Reactor } from "@reactor-team/js-sdk";

const queue = new ReactorQueueClient({ host: PARTYKIT_HOST, autoConnect: true });
queue.subscribe((s) => render(s));      // s.phase, s.position, …

// when the user claims and you want to connect:
queue.claim();
const reactor = new Reactor({ modelName: "lingbot" });
reactor.on("sessionIdChanged", (id) => id && queue.reportSession(id));
await reactor.connect(queue.getJwt);    // getJwt is the resolver
// …later
await reactor.disconnect();
queue.endSession();
```

---

## Lifecycle / phases

The client exposes a single `phase` you can switch on:

`idle → connecting → queued → admitted → active → expired`
(plus `rejected` for a duplicate tab and `disconnected` for a dropped socket).

| Phase | Meaning | Typical UI |
|---|---|---|
| `connecting` | Socket opening | spinner |
| `queued` | In line | "Position {position} of {total}" |
| `admitted` | Slot reserved, token ready, `graceMs` to act | "You're up — Enter" |
| `active` | `claim()`ed; session should be running | the model |
| `expired` | Time elapsed / reclaimed; session stopped | "Rejoin" |
| `rejected` | Duplicate tab; auto-retries | "Open in one tab" |

`sessionEndsAt` (unix ms) drives countdowns: while `admitted` it's the
admission-grace deadline ("time to enter"), while `active` it's the session
deadline. A `time_warning` (with `secondsLeft`) also arrives
`RQ_WARNING_BEFORE_MS` before expiry.

`idle` is not special — it means "not in the queue", and leaving (`leave()`)
returns there too. The SDK intentionally doesn't distinguish "never joined" from
"left after a session"; if you want a "rejoin?" screen, track that in your own
app state (the example does exactly this).

## Using with React — two gotchas

1. **`autoConnect` + StrictMode.** The Reactor SDK's `<ReactorProvider
   autoConnect>` connects on mount and disconnects on cleanup; React StrictMode
   (Next.js dev default) double-invokes that, racing connect against disconnect
   and crashing inside the SDK (`…reading 'pollSessionReady'`). Production never
   double-mounts. Either set `reactStrictMode: false` (what the example does) or
   drop `autoConnect` and connect via a button (what the SDK's own examples do).
2. **Keep `getJwt` stable.** `useReactorQueue().getJwt` is already a stable
   reference — pass it directly (`getJwt={queue.getJwt}`), never wrap it in a
   fresh inline arrow, or the SDK will tear the session down on re-render.

## Configuration (server)

All values resolve as **default → `createReactorQueueServer({...})` → env var**
(env wins, for redeploy-free tuning). The API key must come from a secret.

| Env var | Config key | Default | Purpose |
|---|---|---|---|
| `RQ_REACTOR_API_KEY` | `apiKey` | — (**required**, secret) | Mints JWTs; stops sessions |
| `RQ_MAX_CONCURRENT` | `maxConcurrent` | `1` | Live sessions at once |
| `RQ_SESSION_DURATION_MS` | `sessionDurationMs` | `120000` | Session budget after claim |
| `RQ_ADMISSION_GRACE_MS` | `admissionGraceMs` | `45000` | Time to claim a reserved slot |
| `RQ_WARNING_BEFORE_MS` | `warningBeforeMs` | `30000` | Lead time for `time_warning` |
| `RQ_TOKEN_TTL_SECONDS` | `tokenTtlSeconds` | `60` | Minted JWT lifetime |
| `RQ_POLL_INTERVAL_MS` | `pollIntervalMs` | `15000` | Session reconciliation cadence |
| `RQ_HEARTBEAT_STALE_MS` | `heartbeatStaleMs` | `15000` | Dead-connection threshold |
| `RQ_COORDINATOR_URL` | `coordinatorUrl` | `https://api.reactor.inc` | Reactor API base URL |
| `RQ_API_VERSION` | `apiVersion` | `1` | `Reactor-API-Version` header |
| `RQ_STOP_SESSIONS` | `stopSessionsOnExpiry` | `true` | `DELETE` session on expiry |

`createReactorQueueServer` also accepts `hooks` (`onAdmit`, `onClaim`,
`onExpire`, `onSessionReaped`, `onError`) for logging/metrics.

## Configuration (client)

`ReactorQueueClientOptions` / `<ReactorQueueProvider>` props: `host` (required),
`room`, `party`, `clientId`, `autoConnect`, `heartbeatIntervalMs`,
`tokenSkewMs`, `tokenRequestTimeoutMs`, `retryRejectedMs`.

---

## Repo layout & development

```
packages/
  protocol/   @reactor-team/queue-protocol   shared wire types + defaults
  server/     @reactor-team/queue-server      PartyKit queue engine
  client/     @reactor-team/queue             JS client + React/zustand layer
examples/
  basic/      runnable single-page demo (web app + its own PartyKit room)
skill/        SKILL.md — guide for building queued demos with this library
```

```bash
pnpm install
pnpm build       # build all packages (tsup)
pnpm typecheck   # tsc --noEmit across packages
pnpm dev         # watch-build all packages
pnpm example     # run the basic example (web + PartyKit) — needs examples/basic/.env
```

This is a pnpm workspace; the packages reference each other via `workspace:*`.

## How it improves on a hand-rolled queue

- **One token stage, not two.** The server mints the Reactor JWT directly, so
  there's no separate "admission token → exchange route" hop.
- **Real session teardown.** Expiry calls `DELETE /sessions/{id}`; the GPU is
  freed on time, not whenever Reactor's idle timeout happens to fire.
- **Self-healing slots.** Three independent paths free a slot (explicit end,
  socket close, state poll), so a missed disconnect can't wedge the queue.
- **Tiny client contract.** The client is just `getJwt` + `reportSession` +
  state; it stays decoupled from the Reactor SDK so you can drop it into any
  app.

## License

MIT — see [LICENSE](./LICENSE).
