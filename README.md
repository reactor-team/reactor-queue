# `@reactor-team/queue`

> Drop-in waiting room for [Reactor](https://reactor.inc) demos.
> A PartyKit server + a JS/React client that line users up, **create Reactor
> sessions on the server**, hand each admitted member a **short-lived JWT** plus
> a `sessionId` to attach to, cap how long they can stay, and slide the line
> forward the instant someone leaves.

This library puts a virtual queue in front of a Reactor model so at most
`maxSessions × usersPerSession` people are live at once — everyone else waits in
an orderly line and is admitted automatically as capacity frees. The PartyKit
server owns `POST /sessions`; browsers attach with `connect({ sessionId })`
instead of creating their own sessions. It is a thin utility on top of the
public Reactor REST API; it does not replace or fork anything.

## Why this exists

**Reactor does not gate demand for you.** The platform hands out sessions on
request up to your account's quota; it has no built-in, dynamic waiting room
that holds users back and lets them in as capacity frees. Each live session
also occupies a GPU for its entire duration, so concurrency is a hard,
finite resource. Without something in front, a burst of traffic simply hits the
ceiling and users get errors — there is no graceful "you're next" path. This
library is that missing layer.

Three concrete reasons teams reach for it:

- **It makes a demo feel alive.** A visible line ("you're #5, ~30 sec") signals
  that the thing is real, in-demand, and worth waiting for. Used in the right
  measure, scarcity is a feature — it turns a launch into an event and can help
  drive word-of-mouth instead of a flat "try it" button that quietly 429s under
  load.
- **It protects a hard capacity ceiling.** During a viral moment, uncapped
  traffic exhausts GPU capacity and *everyone's* experience breaks. A queue
  caps concurrent Reactor sessions and members, time-boxes each turn, and
  keeps the wait predictable instead of degrading for everyone.
- **It right-sizes demos for scarce or new models.** Private or early-access
  models (e.g. a model partner's launch) often run on very limited capacity.
  Set `maxSessions` × `usersPerSession` to sit just under the model's known ceiling and the demo
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
 ┌─────────────────────┐  WebSocket  ┌────────────────────────────┐  REST   ┌──────────────────────┐
 │ @reactor-team/queue │◀───────────▶│ @reactor-team/queue-server │────────▶│ POST /tokens         │
 │  • partysocket      │   queue +   │  • FIFO queue + session cap │         │ POST /sessions       │
 │  • getJwt() resolver│   tokens    │  • mints 60s Reactor JWTs  │         │ GET  /sessions/{id}  │
 │  • sessionId on claim│             │  • creates sessions on claim│         │ DELETE /sessions/{id}│
 │  • zustand store    │             │  • per-user session timer  │         └──────────────────────┘
 └──────────┬──────────┘             │  • stops + reaps sessions  │
            │                        └────────────────────────────┘
            │ getJwt + sessionId
            ▼
   @reactor-team/js-sdk  ───────────────────── WebRTC ─────────────────────▶  GPU / model
```

The queue server is the **single source of truth**. It:

1. Lines users up FIFO and reserves a capacity **slot** for the head (fill open
   slots before opening new ones) up to `maxSessions` × `usersPerSession` members.
2. **Creates the Reactor session lazily on `claim()`** (`POST /sessions`), then
   sends `session_ready { sessionId }` so the client attaches via
   `connect({ sessionId })`. Nothing is created during grace, so an abandoned
   admission never orphans a GPU session.
3. **Mints the Reactor JWT itself** (API key is a server secret) and sends it
   only to admitted users — _the queue returns the JWT_.
4. Issues **very short-lived tokens** (default 60s). The client refreshes them
   on demand over the WebSocket via a `request_token` command, exposed as a
   standard `getJwt` resolver for the Reactor SDK.
5. Gives each admitted user a **bounded session** (default 120s). When time runs
   out the server calls `DELETE /sessions/{id}` to actually stop the GPU
   session — not just hide the UI.
6. Frees a slot the instant a member leaves: via an explicit `session_ended`
   message, a raw socket close (closed tab), **or** a periodic poll of the
   tracked session state that catches drop-outs whose notification never
   arrived.

### Sessions and members

Terminology is **session** everywhere (no “room” or “slot” in the API):

| Concept | Meaning |
|---|---|
| **Slot** | A capacity reservation (`slot:<id>` in durable storage). Holds up to `usersPerSession` members and lazily owns one Reactor session. |
| **Member** | One admitted browser connection. Has its own grace/claim timer (`member:<connId>`). |
| **Queue** | Waiting connections, stored one key per waiter (`q:<seq>`) for O(1), unbounded enqueue/dequeue. |

Admission **fills an open slot before opening a new one**: if any slot has
`members.length < usersPerSession`, the head of the queue takes a seat there;
otherwise, when `slotCount < maxSessions`, a new (sessionless) slot is opened.

**The Reactor session is created on `claim()`, not at admission.** When the
first member of a slot claims, the server calls `POST /sessions`, stores the id
on the slot, and sends `session_ready { sessionId }`. Other members of the same
slot reuse that id when they claim. This is the key fix against **orphaned
sessions**: an admitted user who never claims (grace timeout, tab close) frees
their slot with no GPU session ever created.

When the **last member** leaves a slot (timeout, `session_ended`, tab close, or
poll seeing `CLOSED`/`INACTIVE`), the server `DELETE`s its Reactor session if
one was created (and `RQ_STOP_SESSIONS` is on) and removes the slot.

**Capacity** exposed to clients is `maxSessions × usersPerSession` (total live
members). `active` in queue messages is the current member count.

**`usersPerSession > 1`** is supported in the queue’s accounting today; platform
multi-connection per session (sharing one WebRTC session across N clients) is
still rolling out — default `1` matches current behavior.

### js-sdk requirement

Clients must attach with
[`ConnectOptions.sessionId`](https://github.com/reactor-team/js-sdk) (js-sdk
PR #189 or later). Pass it through your provider:

```tsx
connectOptions={{ autoConnect: true, sessionId: q.sessionId }}
```

The queue client sets `sessionId` from the `admitted` WebSocket message — there
is no `reportSession()` or `session_started` wire message anymore.

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

export default createReactorQueueServer({ model: "helios", maxSessions: 3 });
```

```jsonc
// partykit.json
{
  "name": "my-demo-queue",
  "main": "partykit/server.ts",
  "compatibilityDate": "2024-11-01",
  "vars": { "RQ_MODEL": "helios", "RQ_MAX_SESSIONS": "3", "RQ_SESSION_DURATION_MS": "120000" }
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
  if (q.phase !== "active" || !q.sessionId) return null;

  return (
    <ReactorProvider
      modelName="lingbot"
      getJwt={q.getJwt}
      connectOptions={{ autoConnect: true, sessionId: q.sessionId }}
    >
      <SessionBridge />
      {/* your model UI */}
    </ReactorProvider>
  );
}

// Free the queue slot when the user leaves the demo.
function SessionBridge() {
  const { endSession } = useReactorQueue();
  React.useEffect(() => () => endSession(), [endSession]);
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
await reactor.connect(queue.getJwt, { sessionId: queue.getState().sessionId! });
// …later
await reactor.disconnect();
queue.endSession();
```

---

## Lifecycle / phases

The client exposes a single `phase` you can switch on:

`idle → connecting → queued → admitted → starting → active → expired`
(plus `rejected` for a duplicate tab and `disconnected` for a dropped socket).

| Phase | Meaning | Typical UI |
|---|---|---|
| `connecting` | Socket opening | spinner |
| `queued` | In line | "Position {position} of {total}" |
| `admitted` | Capacity slot reserved, `graceMs` to act. No session yet | "You're up — Enter" |
| `starting` | `claim()`ed; server is creating the session | "Starting…" spinner |
| `active` | `session_ready` received; `sessionId` set — attach the SDK | the model |
| `expired` | Time elapsed / reclaimed; session stopped | "Rejoin" |
| `rejected` | Duplicate tab; auto-retries | "Open in one tab" |

`sessionId` is `null` until `active`; gate your `<ReactorProvider>` on
`phase === "active" && sessionId`.

`sessionEndsAt` (unix ms) drives countdowns: while `admitted` it's the
admission-grace deadline ("time to enter"), while `active` it's the session
deadline. A `time_warning` (with `secondsLeft`) also arrives
`RQ_WARNING_BEFORE_MS` before expiry.

### Client state (`QueueState`)

| Field | When set | Use |
|---|---|---|
| `phase` | always | Switch UI (`queued`, `admitted`, `active`, …) |
| `position`, `total` | `queued` | Line position (1-based) |
| `active` | queue updates | Members currently in a session |
| `capacity` | `admitted` / `queue_position` | Max live members (`maxSessions × usersPerSession`) |
| `sessionId` | `admitted` | Pass to `connectOptions.sessionId` |
| `token`, `tokenExpiresAt` | `token` message | Short-lived JWT; `getJwt` refreshes |
| `sessionEndsAt` | `admitted` / `claim` | Countdown (grace, then full session) |
| `sessionDurationMs` | `admitted` | Full budget after `claim()` |
| `secondsLeft` | `time_warning` | Pre-expiry warning |
| `reason` | `rejected` / `expired` / `error` | Display or logging |

Actions: `connect`, `leave`, `rejoin`, `claim`, `endSession`, `getJwt` (stable
reference — pass directly to the SDK).

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
| `RQ_REACTOR_API_KEY` | `apiKey` | — (**required**, secret) | Mints JWTs; creates/stops sessions |
| `RQ_MODEL` | `model` | — (**required**) | Model for `POST /sessions` |
| `RQ_MAX_SESSIONS` | `maxSessions` | `1` | Concurrent Reactor sessions (GPU ceiling) |
| `RQ_USERS_PER_SESSION` | `usersPerSession` | `1` | Members per session (fill-in before create) |
| `RQ_WEBRTC_VERSION` | `webrtcVersion` | `1.0` | WebRTC version in session create body |
| `RQ_SESSION_DURATION_MS` | `sessionDurationMs` | `120000` | Session budget after claim |
| `RQ_ADMISSION_GRACE_MS` | `admissionGraceMs` | `45000` | Time to claim a reserved slot |
| `RQ_WARNING_BEFORE_MS` | `warningBeforeMs` | `30000` | Lead time for `time_warning` |
| `RQ_TOKEN_TTL_SECONDS` | `tokenTtlSeconds` | `60` | Minted JWT lifetime |
| `RQ_POLL_INTERVAL_MS` | `pollIntervalMs` | `15000` | Session reconciliation cadence |
| `RQ_COORDINATOR_URL` | `coordinatorUrl` | `https://api.reactor.inc` | Reactor API base URL |
| `RQ_API_VERSION` | `apiVersion` | `1` | `Reactor-API-Version` header |
| `RQ_STOP_SESSIONS` | `stopSessionsOnExpiry` | `true` | `DELETE` session on expiry |
| `RQ_ADMIN_PASSWORD` | `adminPassword` | — (off) | Password for admin dashboard connections |
| `RQ_ALLOW_DUPLICATE_CONNECTIONS` | `allowDuplicateConnections` | `false` | Allow the same browser to hold multiple connections (disables the duplicate-tab `rejected`) |
| `RQ_SESSION_POOL_URL` | `sessionPoolUrl` | — (off) | Lease sessions from an HTTP pool instead of creating them (see Session pools) |
| `RQ_SESSION_POOL_TOKEN` | `sessionPoolToken` | — | Bearer token for the session pool |

`createReactorQueueServer` also accepts optional **hooks** (not env-configurable):

| Hook | When |
|---|---|
| `onUserConnected(connId)` | Connection joined the queue |
| `onUserDisconnected(connId)` | WebSocket closed |
| `onUserEnteredSession(connId, sessionId)` | Member admitted (JWT + `sessionId` sent) |
| `onSessionCreated(sessionId)` | Server called `POST /sessions` for a new session |
| `onSessionClosed(sessionId, reason)` | Last member left; session record removed |
| `onError(where, error)` | Non-fatal server errors (mint, create, stop, …) |

Debug while developing: `curl http://127.0.0.1:1999/parties/main/<room>` returns
`maxSessions`, `usersPerSession`, `capacity`, `queueLength`, `activeCount`, and
per-session `members` lists.

## Admin mode

Operators can watch the room and kick users without joining the queue. Set
`RQ_ADMIN_PASSWORD` (or `adminPassword` in `createReactorQueueServer`). When unset,
admin connections are rejected.

Connect with `rqAdmin=1` on the WebSocket URL, then send `{ type: "admin_auth", password }`.
The server replies with `admin_ready` and pushes `admin_snapshot` whenever the room
changes. Actions: `admin_kick_member` (evict an admitted user), `admin_kick_queued`
(drop a waiting connection), `admin_close_session`, `admin_refresh`.

**React** — shell only; you build the UI:

```tsx
import { ReactorQueueAdminProvider, useReactorQueueAdmin } from "@reactor-team/queue/admin/react";

<ReactorQueueAdminProvider
  host={PARTYKIT_HOST}
  password={yourPasswordResolver}
  refreshIntervalMs={10_000} // optional poll; server also pushes on every change
>
  <YourDashboard />
</ReactorQueueAdminProvider>

function YourDashboard() {
  const { phase, snapshot, kickMember, kickQueued, closeSession } = useReactorQueueAdmin();
  // snapshot.config, snapshot.queue, snapshot.members, snapshot.sessions
}
```

**Vanilla** — `@reactor-team/queue/admin` exports `ReactorQueueAdminClient`.

See [`examples/basic/app/admin`](./examples/basic/app/admin) for a full dashboard.

## Session pools (a robot already in the room)

By default the queue **creates** a Reactor session on `claim()` and **stops** it
on teardown. For setups where each session should already contain a backend
agent (a "robot" connected via the Python SDK) before the human arrives, swap
session creation for **leasing from a pre-provisioned pool** via a `SessionSource`:

```ts
interface SessionSource {
  acquire(ctx: { model: string }): Promise<string>;      // a ready session id (robot already in it)
  release(sessionId: string, reason: string): Promise<void>; // hand it back / recycle
}
```

`acquire` is called once per slot on the first `claim()` (never during grace, so
an abandoned admission never leases); `release` runs when the slot empties. The
human still attaches with `connect({ sessionId })` and the queue still mints the
JWT, so **leased sessions must belong to the same Reactor account as the queue's
API key**, and the platform must allow the robot + human as two connections in
one session.

Two ways to configure it:

```ts
// 1. Your own implementation (code):
createReactorQueueServer({ model: "helios", sessionSource: myPool });

// 2. The built-in HTTP pool (env): set RQ_SESSION_POOL_URL (+ RQ_SESSION_POOL_TOKEN).
//    Your service implements:
//      POST {url}/lease   { model }            -> { session_id }   (non-2xx = pool empty)
//      POST {url}/release { session_id, reason }
```

If `acquire` throws (pool empty), the client gets an `error` and can retry —
same path as a session-create failure.

## Configuration (client)

`ReactorQueueClientOptions` / `<ReactorQueueProvider>` props: `host` (required),
`room`, `party`, `clientId`, `autoConnect`,
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

## Migrating from the previous queue API

If you integrated an earlier version of this library:

| Before | After |
|---|---|
| `maxConcurrent` / `RQ_MAX_CONCURRENT` | `maxSessions` / `RQ_MAX_SESSIONS` (+ optional `usersPerSession`) |
| Client `POST /sessions` + `reportSession(id)` | Server creates session; use `q.sessionId` in `connectOptions` |
| `session_started` client message | Removed — server sends `sessionId` via `session_ready` after `claim()` |
| Session created on admit / `sessionId` on `admitted` | Created on `claim()`; `sessionId` arrives in `session_ready` (new `starting` phase) |
| `capacity` in wire messages | Replaces `maxConcurrent` in `admitted` / `queue_position` |
| Hooks `onAdmit`, `onClaim`, `onExpire`, … | `onUserConnected`, `onUserEnteredSession`, `onSessionCreated`, … |
| Server config without `model` | **`RQ_MODEL` required** (must match the model your client uses) |

## Hibernation (production scaling)

The PartyKit server opts into [Hibernation](https://docs.partykit.io/guides/scaling-partykit-servers-with-hibernation/)
(`options.hibernate = true`): the platform keeps sockets open but unloads the
server instance between messages, lifting a room from ~100 to ~32k connections
and dropping idle cost to near zero.

The implementation is written for it:

- **All state lives in `room.storage`** (`q:<seq>`/`qpos:<connId>`, `member:<id>`,
  `slot:<id>`, `cid:`/`conn:`, `admin:<id>`) — nothing important is kept in class
  fields, so a wake/restore loses nothing.
- **The queue is stored as one key per waiter** (`q:<seq>` ordered, with a
  `qpos:<connId>` reverse lookup), not a single array — so enqueue/dequeue are
  O(1) and the line isn't capped by the 128 KiB single-value limit (~3k entries).
  Position broadcasts still scan the whole line and give every waiter their exact
  number.
- **No application heartbeat.** Connection liveness comes from the platform
  (`onClose` + `room.getConnection`), so a hibernated room isn't woken every few
  seconds by keep-alives. The duplicate-tab guard checks for a live connection
  instead of a heartbeat timestamp.
- **Broadcasts are coalesced and flushed inside the handler turn** (no in-memory
  `setTimeout`), so a queue-position or admin update can't be dropped if the room
  hibernates between events.
- **Alarms are only scheduled while members/slots exist** and deleted when the
  room empties, so an unused demo hibernates fully.

Note: `partykit dev` does not hibernate — validate hibernation behavior on a
deployed instance.

## How it improves on a hand-rolled queue

- **One token stage, not two.** The server mints the Reactor JWT directly, so
  there's no separate "admission token → exchange route" hop.
- **Real session teardown.** Expiry calls `DELETE /sessions/{id}`; the GPU is
  freed on time, not whenever Reactor's idle timeout happens to fire.
- **Self-healing slots.** Three independent paths free a slot (explicit end,
  socket close, state poll), so a missed disconnect can't wedge the queue.
- **Tiny client contract.** The client is `getJwt` + server-provided `sessionId`
  + state; wire `connectOptions.sessionId` into the Reactor SDK.

## License

MIT — see [LICENSE](./LICENSE).
