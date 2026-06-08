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

## Packages

| Package                                               | What it is                                                                        | You install it…          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------ |
| [`@reactor-team/queue`](./packages/client)            | Client: framework-agnostic `ReactorQueueClient` + React/zustand layer (`./react`) | in your web app          |
| [`@reactor-team/queue-server`](./packages/server)     | The PartyKit `Server` factory                                                     | in your PartyKit project |
| [`@reactor-team/queue-protocol`](./packages/protocol) | Shared wire types + defaults (transitive)                                         | automatically            |

---

## Quickstart

Two pieces: a **server** you run on PartyKit and a **client** you mount in your
web app. Locally, `partykit dev` gives you the room and your dev server the app.

### 1. Server (PartyKit)

Configure the queue in one place — this `createReactorQueueServer` call _is_ the
server. Each option is typed and documented; nothing is duplicated elsewhere:

```ts
// partykit/server.ts
import { createReactorQueueServer } from "@reactor-team/queue-server";

export default createReactorQueueServer({
  model: "helios", // model the queue opens sessions for
  maxSessions: 3, // concurrent GPU sessions — your capacity ceiling
  sessionDurationMs: 120_000, // how long each turn lasts
});
```

`partykit.json` is just PartyKit plumbing — no queue config to keep in sync:

```jsonc
// partykit.json
{
  "name": "my-demo-queue",
  "main": "partykit/server.ts",
  "compatibilityDate": "2024-11-01",
}
```

The Reactor API key is the one value that must **not** live in code — it's a
secret. Put it in `.env` (auto-loaded by `partykit dev`):

```bash
echo "RQ_REACTOR_API_KEY=rk_your_key_here" >> .env
npx partykit dev   # → http://127.0.0.1:1999
```

That's the whole split: **behavior in code, secrets in `.env`.** Every option
also has an `RQ_*` env-var twin if you ever need to override one per-deploy
without editing code (see [Configuration](#configuration-server)) — but you
don't need any of that to start. To go live, see [Deployment](#deployment).

### 2. Client (React)

Requires [`@reactor-team/js-sdk`](https://github.com/reactor-team/js-sdk)
**2.11.2+** (for `ConnectOptions.sessionId`).

```tsx
import { ReactorQueueProvider, useReactorQueue } from "@reactor-team/queue/react";
import { ReactorProvider } from "@reactor-team/js-sdk";

export default function App() {
  return (
    <ReactorQueueProvider host={process.env.NEXT_PUBLIC_PARTYKIT_HOST!}>
      <Gate />
    </ReactorQueueProvider>
  );
}

function Gate() {
  const q = useReactorQueue();
  if (q.phase === "queued")
    return (
      <p>
        Position {q.position} of {q.total}
      </p>
    );
  if (q.phase === "admitted") return <button onClick={q.claim}>Enter</button>;
  if (q.phase === "expired") return <button onClick={q.rejoin}>Rejoin</button>;
  if (q.phase !== "active" || !q.sessionId) return null;

  return (
    <ReactorProvider
      modelName="helios"
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

The two integration points are `getJwt={q.getJwt}` and
`connectOptions.sessionId` — everything else is your normal model UI. See
[`examples/basic`](./examples/basic) for the complete, runnable version
(`app/page.tsx` is the whole thing).

### Vanilla JS (no React)

The same client without the React layer — drive your own UI from `subscribe`:

```ts
import { ReactorQueueClient } from "@reactor-team/queue";
import { Reactor } from "@reactor-team/js-sdk";

const queue = new ReactorQueueClient({ host: PARTYKIT_HOST, autoConnect: true });
queue.subscribe((s) => render(s)); // s.phase, s.position, …

// when the user claims and you want to connect:
queue.claim();
const reactor = new Reactor({ modelName: "helios" });
await reactor.connect(queue.getJwt, { sessionId: queue.getState().sessionId! });
// …later
await reactor.disconnect();
queue.endSession();
```

---

## Deployment

The queue is **two separately-shipped pieces**: the PartyKit server (this
library) and your own web app. The browser bundle talks to the deployed PartyKit
room over WebSocket; the room talks to Reactor over REST. Your web app is **not**
where the queue runs — the server is its own deploy.

### The PartyKit server

`createReactorQueueServer()` is a PartyKit server, which compiles to a
Cloudflare Durable Object — a stateful edge process, not part of your Next.js /
web bundle. You publish it with the PartyKit CLI. A deploy gives you a host like
`my-demo-queue.<your-username>.partykit.dev`, and that host string is exactly
what the client takes as its `host` prop (`NEXT_PUBLIC_PARTYKIT_HOST`).

The Reactor API key is a **server secret** and must never reach the browser.
Push it (and any other secrets, like `RQ_ADMIN_PASSWORD`) to PartyKit, then deploy:

```bash
# Store secrets once (prompts for the value); kept out of partykit.json:
npx partykit secret put RQ_REACTOR_API_KEY
npx partykit secret put RQ_ADMIN_PASSWORD     # only if you use admin mode

# Deploy. `--with-vars` also uploads the non-secret `vars` from partykit.json.
npx partykit deploy --with-vars
```

(Or keep the secret in a local `.env` and let `--with-vars` upload it at deploy
time — the same `.env` that `partykit dev` reads.)

Your queue settings live in code (the `createReactorQueueServer({...})` call).
Any of them can still be overridden at deploy time by the matching `RQ_*` env var
— non-secret overrides go in `partykit.json` `vars`, secrets via
`partykit secret` — so you can retune a deploy without editing code. For anything
public, harden the demo defaults: drop `allowDuplicateConnections`, set
`allowedOrigins` to your site(s), and size `maxSessions` to the model's real GPU
ceiling. Then point your web app at the deployed host and deploy the app wherever
it lives (Vercel, etc.).

### Your own Cloudflare account (cloud-prem)

By default PartyKit deploys to its **managed** platform (the `*.partykit.dev`
host above). Because PartyKit is built on Cloudflare Workers, you can instead
deploy the **same server** to your **own Cloudflare account** — its
[cloud-prem](https://docs.partykit.io/guides/deploy-to-cloudflare/) mode. Reach
for it when you have regulatory requirements, want the room on a domain you
already run on Cloudflare, or want it alongside your existing Workers/services.
The PartyKit platform fee is waived for cloud-prem.

Create a Cloudflare API token from the **Edit Cloudflare Workers** template,
grab your account id, and pass both to `deploy` with a `--domain`:

```bash
CLOUDFLARE_ACCOUNT_ID=<account id> \
CLOUDFLARE_API_TOKEN=<api token> \
  npx partykit deploy --domain queue.yourdomain.com --with-vars
```

The server code and every `RQ_*` value are identical — only the deploy target
changes. The client then connects to `queue.yourdomain.com` instead of the
`*.partykit.dev` host. See PartyKit's
[Deploy to your own Cloudflare account](https://docs.partykit.io/guides/deploy-to-cloudflare/)
guide for token scopes and the full details.

---

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
  traffic exhausts GPU capacity and _everyone's_ experience breaks. A queue
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
- **Reactor model partners** launching private/early-access demos _with_ Reactor
  (e.g. Overworld and similar) — capping a small-capacity model to a safe number
  of concurrent users while still letting a crowd line up.

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

| Concept    | Meaning                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Slot**   | A capacity reservation (`slot:<id>` in durable storage). Holds up to `usersPerSession` members and lazily owns one Reactor session. |
| **Member** | One admitted browser connection. Has its own grace/claim timer (`member:<connId>`).                                                 |
| **Queue**  | Waiting connections, stored one key per waiter (`q:<seq>`) for O(1), unbounded enqueue/dequeue.                                     |

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
[`ConnectOptions.sessionId`](https://github.com/reactor-team/js-sdk), which
shipped in `@reactor-team/js-sdk` **2.11.2**. Install that version (or later) and
pass `sessionId` through your provider:

```tsx
connectOptions={{ autoConnect: true, sessionId: q.sessionId }}
```

The queue client sets `sessionId` from the `admitted` WebSocket message — there
is no `reportSession()` or `session_started` wire message.

## Lifecycle / phases

The client exposes a single `phase` you can switch on:

`idle → connecting → queued → admitted → starting → active → expired`
(plus `rejected` for a duplicate tab and `disconnected` for a dropped socket).

| Phase        | Meaning                                                    | Typical UI                       |
| ------------ | ---------------------------------------------------------- | -------------------------------- |
| `connecting` | Socket opening                                             | spinner                          |
| `queued`     | In line                                                    | "Position {position} of {total}" |
| `admitted`   | Capacity slot reserved, `graceMs` to act. No session yet   | "You're up — Enter"              |
| `starting`   | `claim()`ed; server is creating the session                | "Starting…" spinner              |
| `active`     | `session_ready` received; `sessionId` set — attach the SDK | the model                        |
| `expired`    | Time elapsed / reclaimed; session stopped                  | "Rejoin"                         |
| `rejected`   | Duplicate tab; auto-retries                                | "Open in one tab"                |

`sessionId` is `null` until `active`; gate your `<ReactorProvider>` on
`phase === "active" && sessionId`.

`sessionEndsAt` (unix ms) drives countdowns: while `admitted` it's the
admission-grace deadline ("time to enter"), while `active` it's the session
deadline. A `time_warning` (with `secondsLeft`) also arrives
`RQ_WARNING_BEFORE_MS` before expiry.

### Client state (`QueueState`)

| Field                     | When set                         | Use                                                |
| ------------------------- | -------------------------------- | -------------------------------------------------- |
| `phase`                   | always                           | Switch UI (`queued`, `admitted`, `active`, …)      |
| `position`, `total`       | `queued`                         | Line position (1-based)                            |
| `active`                  | queue updates                    | Members currently in a session                     |
| `capacity`                | `admitted` / `queue_position`    | Max live members (`maxSessions × usersPerSession`) |
| `sessionId`               | `admitted`                       | Pass to `connectOptions.sessionId`                 |
| `token`, `tokenExpiresAt` | `token` message                  | Short-lived JWT; `getJwt` refreshes                |
| `sessionEndsAt`           | `admitted` / `claim`             | Countdown (grace, then full session)               |
| `sessionDurationMs`       | `admitted`                       | Full budget after `claim()`                        |
| `secondsLeft`             | `time_warning`                   | Pre-expiry warning                                 |
| `reason`                  | `rejected` / `expired` / `error` | Display or logging                                 |

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

Configure the server in code via `createReactorQueueServer({...})` — that's the
normal place. Each option _also_ reads from an env var that **overrides** the
code value, so a deploy can be retuned without a code change. Values resolve
**default → `createReactorQueueServer({...})` → env var** (env wins). The API key
must come from a secret, never code.

| Env var                          | Config key                  | Default                   | Purpose                                                                                                            |
| -------------------------------- | --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `RQ_REACTOR_API_KEY`             | `apiKey`                    | — (**required**, secret)  | Mints JWTs; creates/stops sessions                                                                                 |
| `RQ_MODEL`                       | `model`                     | — (**required**)          | Model for `POST /sessions`                                                                                         |
| `RQ_MAX_SESSIONS`                | `maxSessions`               | `1`                       | Concurrent Reactor sessions (GPU ceiling)                                                                          |
| `RQ_USERS_PER_SESSION`           | `usersPerSession`           | `1`                       | Members per session (fill-in before create)                                                                        |
| `RQ_WEBRTC_VERSION`              | `webrtcVersion`             | `1.0`                     | WebRTC version in session create body                                                                              |
| `RQ_SESSION_DURATION_MS`         | `sessionDurationMs`         | `120000`                  | Session budget after claim                                                                                         |
| `RQ_ADMISSION_GRACE_MS`          | `admissionGraceMs`          | `45000`                   | Time to claim a reserved slot                                                                                      |
| `RQ_WARNING_BEFORE_MS`           | `warningBeforeMs`           | `30000`                   | Lead time for `time_warning`                                                                                       |
| `RQ_TOKEN_TTL_SECONDS`           | `tokenTtlSeconds`           | `60`                      | Minted JWT lifetime                                                                                                |
| `RQ_POLL_INTERVAL_MS`            | `pollIntervalMs`            | `15000`                   | Session reconciliation cadence                                                                                     |
| `RQ_COORDINATOR_URL`             | `coordinatorUrl`            | `https://api.reactor.inc` | Reactor API base URL                                                                                               |
| `RQ_API_VERSION`                 | `apiVersion`                | `1`                       | `Reactor-API-Version` header                                                                                       |
| `RQ_STOP_SESSIONS`               | `stopSessionsOnExpiry`      | `true`                    | `DELETE` session on expiry                                                                                         |
| `RQ_ADMIN_PASSWORD`              | `adminPassword`             | — (off)                   | Password for admin dashboard connections                                                                           |
| `RQ_ALLOW_DUPLICATE_CONNECTIONS` | `allowDuplicateConnections` | `false`                   | Allow the same browser to hold multiple connections (disables the duplicate-tab `rejected`)                        |
| `RQ_ALLOWED_ORIGINS`             | `allowedOrigins`            | — (allow all)             | Comma-separated `Origin` allow-list for WebSocket connections; unset accepts any origin, `*` allows all explicitly |

`acquireSession` / `releaseSession` are code-only overrides (functions, not env) —
see [Overriding session lifecycle](#overriding-session-lifecycle).

`createReactorQueueServer` also accepts optional **hooks** (not env-configurable):

| Hook                                      | When                                             |
| ----------------------------------------- | ------------------------------------------------ |
| `onUserConnected(connId)`                 | Connection joined the queue                      |
| `onUserDisconnected(connId)`              | WebSocket closed                                 |
| `onUserEnteredSession(connId, sessionId)` | Member admitted (JWT + `sessionId` sent)         |
| `onSessionCreated(sessionId)`             | Server called `POST /sessions` for a new session |
| `onSessionClosed(sessionId, reason)`      | Last member left; session record removed         |
| `onError(where, error)`                   | Non-fatal server errors (mint, create, stop, …)  |

To inspect a running room — capacity, the live queue, members, and per-session
state — connect as an [admin](#admin-mode). There is no unauthenticated status
endpoint: room state is only ever exposed over an authenticated admin
connection, never to an anonymous HTTP request.

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
</ReactorQueueAdminProvider>;

function YourDashboard() {
  const { phase, snapshot, logs, kickMember, kickQueued, closeSession } = useReactorQueueAdmin();
  // snapshot.config, snapshot.queue, snapshot.members, snapshot.sessions
  // logs: AdminLogEntry[] — the live activity stream (see below)
}
```

**Vanilla** — `@reactor-team/queue/admin` exports `ReactorQueueAdminClient`.

See [`examples/basic/app/admin`](./examples/basic/app/admin) for a full dashboard.

### Activity log

Beyond the snapshot, the server streams a **structured activity log** to every
authenticated admin. Each notable event — a user joining, an admission, a session
created or closed, a timeout, an admin action, and every non-fatal **error** — is
emitted as an [`AdminLogEntry`](./packages/protocol/src/index.ts):

```ts
interface AdminLogEntry {
  id: string;
  at: number; // unix ms
  level: "info" | "warn" | "error";
  event: string; // e.g. "user_admitted", "session_create_failed"
  message: string; // human-readable summary
  connId?: string;
  sessionId?: string;
  data?: Record<string, unknown>; // structured context (HTTP status, body, …)
}
```

On the wire it is two server→admin messages: a one-time `admin_log_history`
(recent history, sent right after auth) and a live `admin_log` per new event. The
client layer accumulates both into `useReactorQueueAdmin().logs` (oldest → newest,
capped client-side), so a dashboard just maps over `logs`.

To stay cheap inside a Cloudflare Durable Object, the two tiers split by severity:
**every** event is _streamed_ live to connected admins, but only `warn`/`error`
are _persisted_ to the bounded ring buffer (last 200, durable, survives
hibernation) that seeds `admin_log_history`. The high-frequency `info` events (a
connect, an admission, a disconnect) never touch storage — keeping the hot path
storage-free — while the rare, diagnostic failures are kept as history for an
admin who connects after the fact. The server **console** always gets every event
regardless of admin mode. Connection rejections (forbidden origin, duplicate tab)
are console-only and never enter the stream or storage, so an unauthenticated
flood can't drive admin work.

Everything funnels through one server-side `log(level, event, message, …)` helper,
so adding a logged event is a single call. Errors additionally fire the
[`onError`](#configuration-server) hook for your own metrics pipeline.

#### Diagnosing session-creation failures

The most useful thing the log surfaces is **why the Reactor API rejected a
request**. A failed `POST /sessions` (or token mint, or stop) throws a
[`CoordinatorError`](./packages/server/src/coordinator.ts) carrying the endpoint,
HTTP status, and response body, which the log records verbatim under
`event: "session_create_failed"`:

```jsonc
{
  "level": "error",
  "event": "session_create_failed",
  "message": "POST /sessions failed: 403 {\"error\":\"quota exceeded: 5 concurrent sessions\"}",
  "connId": "abc123",
  "data": {
    "endpoint": "POST /sessions",
    "status": 403,
    "body": "{\"error\":\"quota exceeded: 5 concurrent sessions\"}",
  },
}
```

So when the queue caps out at a number that isn't your `maxSessions` — e.g. your
**account's** concurrent-session quota is lower than the queue's ceiling — the
admin log shows it plainly (`status: 403`, the quota message in `body`) instead of
a silent stall. The browser client never sees this detail; it only gets a generic
`error` with `session_create_failed`.

## Overriding session lifecycle

How a session is obtained on `claim()` and what happens when a user leaves are
two **overridable callbacks**. By default they create and delete sessions via the
Reactor API; override either to plug in your own behavior.

You'd reach for this when the queue shouldn't own the session — for example when
sessions come from **another service** that pre-provisions them, or when each
session already has a **different kind of client attached** before the queued
user arrives (a non-interactive participant, an agent/bot, a teleoperated peer).
In those cases `acquire` leases an existing session id instead of creating one,
and `release` tells the owning service that the user left rather than deleting.

```ts
createReactorQueueServer({
  model: "helios",

  // Get a session id when a user claims. Called once per session (first member).
  // Default: POST /sessions. Override to lease one from an external service.
  acquireSession: async ({ model }) => {
    const r = await fetch(`${POOL}/lease`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model }),
    });
    return (await r.json()).session_id; // throw if none available → client gets `error`, retries
  },

  // A user LEFT the session (not necessarily "delete it"). You get who left and
  // whether they were the last one. Default: delete via DELETE /sessions on the
  // last member. Override to keep the session and just react (e.g. hand it back).
  releaseSession: async ({ sessionId, userId, reason, lastMember }) => {
    await fetch(`${POOL}/left`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        session_id: sessionId,
        user_id: userId,
        reason,
        last_member: lastMember,
      }),
    });
  },
});
```

- `acquireSession` runs on the first `claim()` of a session — never during grace,
  so an abandoned admission never acquires anything.
- `releaseSession` runs each time a member leaves (timeout, disconnect, end, kick),
  with `userId` (the connection that left) and `lastMember`. Use `lastMember` to
  decide whether to tear the session down or leave it running for any remaining
  participants.

The queued user still attaches with `connect({ sessionId })` and the queue still
mints the JWT, so a custom-acquired session **must belong to the same Reactor
account as the queue's API key**. If another client is meant to share the session
with the queued user, the platform must allow more than one connection per session.

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
The `pnpm example` target runs the in-repo demo, which already consumes the
packages this way — so the fastest way to try a change is to run `pnpm dev` (watch
build) in one terminal and `pnpm example` in another.

## Using the library locally (without npm)

These packages aren't on npm yet (see [Milestones](#milestones)). Until they are
— or whenever you want to test an unreleased change against your own app — point
your project at a local checkout instead of the registry. Clone this repo next to
your app and **build the packages first** (their `package.json` `main`/`types`
point at `dist/`, so an unbuilt checkout resolves to nothing):

```bash
git clone https://github.com/reactor-team/reactor-queue
cd reactor-queue
pnpm install
pnpm build       # or `pnpm dev` to rebuild on every change (see below)
```

Then wire your app to that checkout with one of the approaches below.

### Recommended: a pnpm `link:` override

In **your app's** `package.json`, override the three packages to the local
directories. This is resolved for transitive deps too, so the internal
`workspace:*` references (`@reactor-team/queue` → `queue-protocol`) point at your
checkout as well:

```jsonc
{
  "dependencies": {
    "@reactor-team/queue": "*",
  },
  "devDependencies": {
    "@reactor-team/queue-server": "*",
  },
  "pnpm": {
    "overrides": {
      "@reactor-team/queue": "link:../reactor-queue/packages/client",
      "@reactor-team/queue-server": "link:../reactor-queue/packages/server",
      "@reactor-team/queue-protocol": "link:../reactor-queue/packages/protocol",
    },
  },
}
```

```bash
pnpm install   # in your app — now imports resolve to the local checkout
```

Install `@reactor-team/queue` where your web app lives and
`@reactor-team/queue-server` in your PartyKit project (often the same repo).
Adjust the relative paths (`../reactor-queue/...`) to wherever you cloned it.

### Live edits while you develop

Run the watcher in the queue checkout so edits rebuild `dist/` automatically:

```bash
pnpm dev   # in the reactor-queue checkout: watch-build all three packages
```

With the `link:` override above, your app picks up each rebuild on the next
reload (restart `partykit dev` / your dev server if it caches modules). No
re-`install` or re-link step per change.

### Alternative: `pnpm link --global`

If you'd rather not touch your app's `package.json`, link globally from the
checkout and consume from your app:

```bash
# in the reactor-queue checkout (after pnpm build)
pnpm --filter @reactor-team/queue link --global
pnpm --filter @reactor-team/queue-server link --global

# in your app
pnpm link --global @reactor-team/queue
pnpm link --global @reactor-team/queue-server
```

The `link:` override is generally less surprising because it also pins the
transitive `@reactor-team/queue-protocol` to your checkout; with global links you
may need to link `@reactor-team/queue-protocol` too.

### Verifying the real published artifact

To test exactly what npm consumers will get — including the `files`/`prepack`
packaging — build a tarball and install that:

```bash
# in the reactor-queue checkout
pnpm --filter @reactor-team/queue pack   # → reactor-team-queue-0.1.0.tgz

# in your app
pnpm add ../reactor-queue/packages/client/reactor-team-queue-0.1.0.tgz
```

`pnpm pack` runs the same `prepack`/`postpack` as publishing, so the tarball
contains `dist/`, `README.md`, `LICENSE`, and `NOTICE` — a faithful preview of
the published package.

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
  - state; wire `connectOptions.sessionId` into the Reactor SDK.

## Milestones

Where this library is headed. Checked boxes are shipped; the first unchecked box
is what's up next. The rest is roughly ordered intent, not a commitment.

- [x] Server-owned sessions (queue creates/stops the Reactor session)
- [x] Hibernation-ready storage model for production-scale rooms
- [x] Admin dashboard (watch the room, kick members, close sessions)
- [ ] **Distributing on npmjs** — publish `@reactor-team/queue`,
      `@reactor-team/queue-server`, and `@reactor-team/queue-protocol` to the
      public registry so consumers install them directly instead of from source.

## License

[Apache 2.0](./LICENSE) © 2026 Reactor Technologies, Inc.

See [NOTICE](./NOTICE) for attribution requirements and
[CONTRIBUTING.md](./CONTRIBUTING.md) for the contributor sign-off (DCO) policy.
