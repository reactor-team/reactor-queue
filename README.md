# `@reactor-team/queue`

> Drop-in waiting room for [Reactor](https://reactor.inc) demos.
> A PartyKit server lines users up, creates Reactor sessions server-side, and
> hands each admitted user a short-lived JWT plus a `sessionId` to connect with.
> When someone leaves, the next person is admitted automatically.

Put a virtual queue in front of a Reactor model so at most
`maxSessions × usersPerSession` people are live at once. Everyone else waits in
an orderly line and is admitted as capacity frees. The PartyKit server owns
`POST /sessions`; browsers attach to a server-created session with
`connect({ sessionId })`. It's a thin layer over the public Reactor REST API.

## One package, subpath entry points

Everything ships in a single package — **[`@reactor-team/queue`](./packages/queue)** —
with a subpath entry point per surface. Install it once and import the half you need:

| Import                                                          | What it is                                                      | Where it runs         |
| --------------------------------------------------------------- | --------------------------------------------------------------- | --------------------- |
| `@reactor-team/queue`                                           | Framework-agnostic `ReactorQueueClient`                         | your web app          |
| `@reactor-team/queue/react`                                     | React/zustand layer (`ReactorQueueProvider`, `useReactorQueue`) | your web app          |
| `@reactor-team/queue/server`                                    | PartyKit `Server` factory (`createReactorQueueServer`)          | your PartyKit project |
| `@reactor-team/queue/admin` · `@reactor-team/queue/admin/react` | Admin client + React layer (operator dashboard)                 | your admin UI         |
| `@reactor-team/queue/protocol`                                  | Shared wire types + defaults (rarely imported directly)         | both                  |

One package means one version to install and bump, and the client and server
stay on matching wire types.

---

## Quickstart

Two pieces: a **server** you run on PartyKit and a **client** you mount in your
web app. Locally, `partykit dev` serves the room and your dev server the app.

### 1. Server (PartyKit)

The `createReactorQueueServer` call is the whole server — set the model,
capacity, and timings here:

```ts
// partykit/server.ts
import { createReactorQueueServer } from "@reactor-team/queue/server";

export default createReactorQueueServer({
  model: "helios", // model the queue opens sessions for
  maxSessions: 3, // concurrent GPU sessions — your capacity ceiling
  sessionDurationMs: 120_000, // how long each turn lasts
});
```

`partykit.json` is standard PartyKit config:

```jsonc
// partykit.json
{
  "name": "my-demo-queue",
  "main": "partykit/server.ts",
  "compatibilityDate": "2024-11-01",
}
```

Keep the Reactor API key out of code — put it in `.env`, which `partykit dev`
loads automatically:

```bash
echo "RQ_REACTOR_API_KEY=rk_your_key_here" >> .env
npx partykit dev   # → http://127.0.0.1:1999
```

Behavior lives in code; secrets live in `.env`. Every option also has an `RQ_*`
env-var twin for per-deploy overrides (see [Configuration](#configuration-server)),
but you don't need any of that to start. To go live, see [Deployment](#deployment).

### 2. Client (React)

Requires [`@reactor-team/js-sdk`](https://github.com/reactor-team/js-sdk)
**2.12.0+** (for `ConnectOptions.connectionId`).

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
  if (q.phase !== "active" || !q.sessionId || !q.connectionId) return null;

  return (
    <ReactorProvider
      modelName="helios"
      getJwt={q.getJwt}
      connectOptions={{ autoConnect: true, sessionId: q.sessionId, connectionId: q.connectionId }}
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
`connectOptions.sessionId`/`connectionId`; the rest is your normal model UI. See
[`examples/basic`](./examples/basic) for the complete, runnable version.

### Vanilla JS (no React)

The same client without the React layer — drive your own UI from `subscribe`:

```ts
import { ReactorQueueClient } from "@reactor-team/queue";
import { Reactor } from "@reactor-team/js-sdk";

const queue = new ReactorQueueClient({ host: PARTYKIT_HOST, autoConnect: true });
queue.subscribe((s) => render(s)); // s.phase, s.position, …

// when the user claims and the session is ready (phase "active"):
queue.claim();
const { sessionId, connectionId } = queue.getState();
const reactor = new Reactor({ modelName: "helios" });
await reactor.connect(queue.getJwt, { sessionId: sessionId!, connectionId: connectionId! });
// …later
await reactor.disconnect();
queue.endSession();
```

---

## Deployment

The queue ships as two separately-deployed pieces: the PartyKit server (this
library) and your own web app. The browser bundle talks to the deployed PartyKit
room over WebSocket; the room talks to Reactor over REST.

### The PartyKit server

`createReactorQueueServer()` compiles to a Cloudflare Durable Object — a stateful
edge process you publish with the PartyKit CLI, separate from your web bundle. A
deploy gives you a host like `my-demo-queue.<your-username>.partykit.dev`, and
that host string is what the client takes as its `host` prop
(`NEXT_PUBLIC_PARTYKIT_HOST`).

The Reactor API key is a server secret. Push it (and any others, like
`RQ_ADMIN_PASSWORD`) to PartyKit, then deploy:

```bash
# Store secrets once (prompts for the value); kept out of partykit.json:
npx partykit secret put RQ_REACTOR_API_KEY
npx partykit secret put RQ_ADMIN_PASSWORD     # only if you use admin mode

# Deploy. `--with-vars` also uploads the non-secret `vars` from partykit.json.
npx partykit deploy --with-vars
```

(Or keep the secret in a local `.env` and let `--with-vars` upload it at deploy
time — the same `.env` that `partykit dev` reads.)

Queue settings live in code (the `createReactorQueueServer({...})` call), and any
of them can be overridden at deploy time by the matching `RQ_*` env var —
non-secret overrides in `partykit.json` `vars`, secrets via `partykit secret`. For
a public demo, harden the defaults: drop `allowDuplicateConnections`, set
`allowedOrigins` to your site(s), and size `maxSessions` to the model's real GPU
ceiling. Then point your web app at the deployed host and deploy it wherever it
lives (Vercel, etc.).

### Your own Cloudflare account (cloud-prem)

By default PartyKit deploys to its managed platform (the `*.partykit.dev` host
above). Because PartyKit runs on Cloudflare Workers, you can deploy the same
server to your own Cloudflare account instead — its
[cloud-prem](https://docs.partykit.io/guides/deploy-to-cloudflare/) mode. Reach
for it when you have regulatory requirements, want the room on a domain you
already run on Cloudflare, or want it alongside your existing Workers. The
PartyKit platform fee is waived for cloud-prem.

Create a Cloudflare API token from the **Edit Cloudflare Workers** template, grab
your account id, and pass both to `deploy` with a `--domain`:

```bash
CLOUDFLARE_ACCOUNT_ID=<account id> \
CLOUDFLARE_API_TOKEN=<api token> \
  npx partykit deploy --domain queue.yourdomain.com --with-vars
```

The server code and every `RQ_*` value stay the same — only the deploy target
changes — and the client connects to `queue.yourdomain.com` instead. See
PartyKit's
[Deploy to your own Cloudflare account](https://docs.partykit.io/guides/deploy-to-cloudflare/)
guide for token scopes and full details.

---

## Why this exists

Reactor hands out sessions on request up to your account's quota, and each live
session occupies a GPU for its whole duration — so concurrency is a hard, finite
resource. This library adds the waiting room in front of it: a dynamic line that
holds users back and admits them as capacity frees, instead of letting a traffic
burst hit the ceiling and return errors.

Teams reach for it to:

- **Make a demo feel alive.** A visible line ("you're #5, ~30 sec") signals that
  the thing is real, in demand, and worth waiting for. Used well, scarcity turns
  a launch into an event and drives word-of-mouth.
- **Protect a hard capacity ceiling.** A queue caps concurrent Reactor sessions
  and members, time-boxes each turn, and keeps the wait predictable during a
  viral moment instead of degrading for everyone.
- **Right-size demos for scarce or new models.** Early-access models often run on
  very limited capacity. Set `maxSessions × usersPerSession` to sit just under the
  model's known ceiling and the demo runs smoothly within its means while every
  visitor still gets a fair, automatic turn.

## Who it's for

Anyone building on Reactor who needs to meter live access to a model:

- **Reactor API-platform users** adding a waiting room to their own
  Reactor-powered app or demo.
- **Reactor's own demos**, gating first-party launches and public showcases.
- **Reactor model partners** launching private/early-access demos with Reactor
  (e.g. Overworld) — capping a small-capacity model to a safe number of concurrent
  users while still letting a crowd line up.

## Mental model

```
   Browser (your app)                    PartyKit room (you deploy)            Reactor Coordinator
 ┌─────────────────────┐  WebSocket  ┌────────────────────────────┐  REST   ┌──────────────────────┐
 │ @reactor-team/queue │◀───────────▶│ @reactor-team/queue/server │────────▶│ POST /tokens         │
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

The queue server is the single source of truth. It:

1. Lines users up FIFO and reserves a capacity **slot** for the head (filling open
   slots before opening new ones) up to `maxSessions × usersPerSession` members.
2. Creates the Reactor session lazily on `claim()` (`POST /sessions`) and mints a
   WebRTC connection under it (`POST .../connections`), then sends
   `session_ready { sessionId, connectionId }` so the client attaches via
   `connect({ sessionId, connectionId })`. The server owns both the session and
   every connection; the client only adopts them. Creating nothing during grace
   means an abandoned admission never orphans a GPU session.
3. Mints the Reactor JWT server-side (the API key is a server secret) and sends it
   only to admitted users.
4. Issues short-lived tokens (default 60s). The client refreshes them on demand
   over the WebSocket via a `request_token` command, exposed as a standard `getJwt`
   resolver for the Reactor SDK.
5. Gives each admitted user a bounded session (default 120s), then calls
   `DELETE /sessions/{id}` to stop the GPU session when time runs out.
6. Frees a slot the instant a member leaves — via an explicit `session_ended`
   message, a raw socket close (closed tab), or a periodic poll of session state
   that catches drop-outs whose notification never arrived.

### Sessions and members

The API uses **session** throughout (no "room"):

| Concept    | Meaning                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Slot**   | A capacity reservation (`slot:<id>` in durable storage). Holds up to `usersPerSession` members and lazily owns one Reactor session. |
| **Member** | One admitted browser connection. Has its own grace/claim timer (`member:<connId>`).                                                 |
| **Queue**  | Waiting connections, stored one key per waiter (`q:<seq>`) for O(1), unbounded enqueue/dequeue.                                     |

Admission fills an open slot before opening a new one: if any slot has
`members.length < usersPerSession`, the head of the queue takes a seat there;
otherwise, when `slotCount < maxSessions`, a new (sessionless) slot opens.

The Reactor session and each member's connection are created on `claim()`, not at
admission. When the first member of a slot claims, the server calls `POST /sessions`
and stores the id on the slot; every claiming member then gets its own
server-minted WebRTC connection (`POST .../connections`). The server sends
`session_ready { sessionId, connectionId }` and the member reuses the slot's
session id — so an admitted user who never claims (grace timeout, tab close) frees
their slot with no GPU session ever created.

When the last member leaves a slot (timeout, `session_ended`, tab close, or poll
seeing `CLOSED`/`INACTIVE`), the server `DELETE`s its Reactor session if one was
created (and `RQ_STOP_SESSIONS` is on) and removes the slot. A non-last member
leaving just frees its seat: the session stays alive for the others, and the
platform reaps that member's connection on its own.

Capacity exposed to clients is `maxSessions × usersPerSession` (total live
members); `active` in queue messages is the current member count.

`usersPerSession > 1` works end-to-end: N members share one Reactor session, each
with a distinct server-minted connection. The platform caps `connections_per_session`
at **4 by default** — to put more than 4 members on one session, raise that quota
for your account, or the connection mint `429`s and the queue spills the member into
another (or new) session, using more GPU. The connection mint is the real capacity
test: when a session is at its cap, the queue retries on another open session before
opening a new one.

### Who creates and who stops

The server owns the full lifecycle — it creates the session, mints every
connection, and is the only thing that stops the session (`DELETE /sessions` on the
last member, via timeout, `session_ended`, tab close, the liveness poll, or admin
action). Because the client attaches with `connect({ sessionId, … })`, the SDK
treats it as an _adopter_ and won't `DELETE` on disconnect — so a closing client tab
leaves the session running for any other members, and the queue decides when it
ends. Keep `RQ_STOP_SESSIONS` on (the default); the client isn't even a fallback
stopper, so turning it off leaves only Reactor's idle timeout to reclaim the GPU.

### js-sdk requirement

Clients attach with
[`ConnectOptions.sessionId` and `connectionId`](https://github.com/reactor-team/js-sdk),
which shipped in `@reactor-team/js-sdk` **2.12.0**. Install that version (or later)
and pass both through your provider — the queue exposes them as `q.sessionId` and
`q.connectionId` once `phase === "active"`:

```tsx
connectOptions={{ autoConnect: true, sessionId: q.sessionId, connectionId: q.connectionId }}
```

Pass both: omitting `sessionId` would make the SDK create (and own, and delete) its
own session, bypassing the queue.

## Lifecycle / phases

The client exposes a single `phase` you can switch on:

`idle → connecting → queued → admitted → starting → active → expired`
(plus `rejected` for a duplicate tab and `disconnected` for a dropped socket).

| Phase        | Meaning                                                    | Typical UI                       |
| ------------ | ---------------------------------------------------------- | -------------------------------- |
| `connecting` | Socket opening                                             | spinner                          |
| `queued`     | In line                                                    | "Position {position} of {total}" |
| `admitted`   | Capacity slot reserved, `graceMs` to act. No session yet   | "You're up — Enter"              |
| `starting`   | `claim()`ed; server is creating the session + connection   | "Starting…" spinner              |
| `active`     | `session_ready`; `sessionId` + `connectionId` set — attach | the model                        |
| `expired`    | Time elapsed / reclaimed; session stopped                  | "Rejoin"                         |
| `rejected`   | Duplicate tab; auto-retries                                | "Open in one tab"                |

`sessionId` and `connectionId` are `null` until `active`; gate your
`<ReactorProvider>` on `phase === "active" && sessionId && connectionId`.

`sessionEndsAt` (unix ms) drives countdowns: while `admitted` it's the
admission-grace deadline ("time to enter"), while `active` it's the session
deadline. A `time_warning` (with `secondsLeft`) arrives `RQ_WARNING_BEFORE_MS`
before expiry.

### Client state (`QueueState`)

| Field                     | When set                         | Use                                                |
| ------------------------- | -------------------------------- | -------------------------------------------------- |
| `phase`                   | always                           | Switch UI (`queued`, `admitted`, `active`, …)      |
| `position`, `total`       | `queued`                         | Line position (1-based)                            |
| `active`                  | queue updates                    | Members currently in a session                     |
| `capacity`                | `admitted` / `queue_position`    | Max live members (`maxSessions × usersPerSession`) |
| `sessionId`               | `active`                         | Pass to `connectOptions.sessionId`                 |
| `connectionId`            | `active`                         | Pass to `connectOptions.connectionId`              |
| `token`, `tokenExpiresAt` | `token` message                  | Short-lived JWT; `getJwt` refreshes                |
| `sessionEndsAt`           | `admitted` / `claim`             | Countdown (grace, then full session)               |
| `sessionDurationMs`       | `admitted`                       | Full budget after `claim()`                        |
| `secondsLeft`             | `time_warning`                   | Pre-expiry warning                                 |
| `reason`                  | `rejected` / `expired` / `error` | Display or logging                                 |

Actions: `connect`, `leave`, `rejoin`, `claim`, `endSession`, `getJwt` (stable
reference — pass directly to the SDK).

`idle` means "not in the queue", and `leave()` returns there too. The client
doesn't distinguish "never joined" from "left after a session"; if you want a
"rejoin?" screen, track that in your own app state (the example does this).

## Using with React — two gotchas

1. **`autoConnect` + StrictMode.** The Reactor SDK's `<ReactorProvider
autoConnect>` connects on mount and disconnects on cleanup; React StrictMode
   (Next.js dev default) double-invokes that, racing connect against disconnect
   and crashing inside the SDK (`…reading 'pollSessionReady'`). Production doesn't
   double-mount. Either set `reactStrictMode: false` (what the example does) or
   drop `autoConnect` and connect via a button.
2. **Keep `getJwt` stable.** `useReactorQueue().getJwt` is already a stable
   reference — pass it directly (`getJwt={queue.getJwt}`) rather than wrapping it
   in a fresh inline arrow, which would tear the session down on re-render.

## Configuration (server)

Configure the server in code via `createReactorQueueServer({...})`. Each option
also reads from an env var that **overrides** the code value, so a deploy can be
retuned without a code change. Values resolve **default → `createReactorQueueServer({...})`
→ env var** (env wins). The API key must come from a secret.

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

To inspect a running room — capacity, the live queue, members, per-session state —
connect as an [admin](#admin-mode). Room state is exposed only over an
authenticated admin connection.

## Admin mode

Operators can watch the room and kick users without joining the queue. Set
`RQ_ADMIN_PASSWORD` (or `adminPassword` in `createReactorQueueServer`); when unset,
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

Alongside the snapshot, the server streams a structured activity log to every
authenticated admin. Each notable event — a user joining, an admission, a session
created or closed, a timeout, an admin action, and every non-fatal error — is
emitted as an [`AdminLogEntry`](./packages/queue/src/protocol.ts):

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

On the wire it's two server→admin messages: a one-time `admin_log_history` (recent
history, sent right after auth) and a live `admin_log` per new event. The client
layer accumulates both into `useReactorQueueAdmin().logs` (oldest → newest, capped
client-side), so a dashboard just maps over `logs`.

To stay cheap inside a Cloudflare Durable Object, the two tiers split by severity:
every event is streamed live to connected admins, but only `warn`/`error` are
persisted to a bounded ring buffer (last 200, durable, survives hibernation) that
seeds `admin_log_history`. High-frequency `info` events (a connect, an admission, a
disconnect) stay off storage to keep the hot path fast, while rare diagnostic
failures are kept as history for an admin who connects later. The server console
always gets every event. Connection rejections (forbidden origin, duplicate tab)
are console-only.

Everything funnels through one server-side `log(level, event, message, …)` helper,
so adding a logged event is a single call. Errors also fire the
[`onError`](#configuration-server) hook for your own metrics pipeline.

#### Diagnosing session-creation failures

The most useful thing the log surfaces is why the Reactor API rejected a request.
A failed `POST /sessions` (or token mint, or stop) throws a
[`CoordinatorError`](./packages/queue/src/server/coordinator.ts) carrying the
endpoint, HTTP status, and response body, recorded verbatim under
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
account's concurrent-session quota is lower than the queue's ceiling — the admin
log shows it plainly (`status: 403`, the quota message in `body`). The browser
client only gets a generic `error` with `session_create_failed`.

## Overriding session lifecycle

How a session is obtained on `claim()`, and what happens when a user leaves, are
two overridable callbacks. By default they create and delete sessions via the
Reactor API; override either to plug in your own behavior.

Reach for this when the queue shouldn't own the session — for example when
sessions come from another service that pre-provisions them, or when each session
already has a different kind of client attached before the queued user arrives (a
non-interactive participant, an agent/bot, a teleoperated peer). Then `acquire`
leases an existing session id instead of creating one, and `release` tells the
owning service the user left rather than deleting.

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
mints the JWT, so a custom-acquired session must belong to the same Reactor
account as the queue's API key. If another client shares the session with the
queued user, the platform must allow more than one connection per session.

## Configuration (client)

`ReactorQueueClientOptions` / `<ReactorQueueProvider>` props: `host` (required),
`room`, `party`, `clientId`, `autoConnect`, `tokenSkewMs`,
`tokenRequestTimeoutMs`, `retryRejectedMs`.

---

## Repo layout & development

```
packages/
  queue/      @reactor-team/queue — one package, subpath entry points:
                src/                client + React layer  → "." and "/react"
                src/admin-*         admin client + React  → "/admin", "/admin/react"
                src/server/         PartyKit queue engine → "/server"
                src/protocol.ts     shared wire types     → "/protocol"
examples/
  basic/      runnable single-page demo (web app + its own PartyKit room)
skills/       agent skills (one folder each, with a SKILL.md):
  building-reactor-queue-demos/   build a queued demo with this library
  deploy-partykit/                deploy the PartyKit room to Cloudflare
```

```bash
pnpm install
pnpm build       # build all packages (tsup)
pnpm typecheck   # tsc --noEmit across packages
pnpm test        # run the unit test suite (vitest)
pnpm dev         # watch-build all packages
pnpm example     # run the basic example (web + PartyKit) — needs examples/basic/.env
```

Unit tests live in [`packages/queue/test`](./packages/queue/test) and run on every
pull request and push to `main` (the `Test` workflow). They are hermetic — no
network, PartyKit, or Reactor calls — driving the wire protocol, the client and
admin state machines, the PartyKit server engine (against an in-memory room), and
the Coordinator REST client (against a stubbed `fetch`).

This is a pnpm workspace; the example consumes the package via `workspace:*`. The
fastest way to try a change is `pnpm dev` (watch build) in one terminal and
`pnpm example` in another.

## Hibernation (production scaling)

The PartyKit server opts into [Hibernation](https://docs.partykit.io/guides/scaling-partykit-servers-with-hibernation/)
(`options.hibernate = true`): the platform keeps sockets open but unloads the
server instance between messages, lifting a room from ~100 to ~32k connections and
dropping idle cost to near zero.

The implementation is written for it:

- **All state lives in `room.storage`** (`q:<seq>`/`qpos:<connId>`, `member:<id>`,
  `slot:<id>`, `cid:`/`conn:`, `admin:<id>`), so a wake/restore loses nothing.
- **The queue is one key per waiter** (`q:<seq>` ordered, with a `qpos:<connId>`
  reverse lookup) rather than a single array, so enqueue/dequeue are O(1) and the
  line isn't capped by the 128 KiB single-value limit. Position broadcasts still
  scan the line and give every waiter their exact number.
- **No application heartbeat.** Connection liveness comes from the platform
  (`onClose` + `room.getConnection`), so a hibernated room isn't woken by
  keep-alives. The duplicate-tab guard checks for a live connection instead of a
  heartbeat timestamp.
- **Broadcasts are coalesced and flushed inside the handler turn** (no in-memory
  `setTimeout`), so a queue-position or admin update survives a hibernation between
  events.
- **Alarms are scheduled only while members/slots exist** and deleted when the room
  empties, so an unused demo hibernates fully.

`partykit dev` does not hibernate — validate hibernation behavior on a deployed
instance.

## Milestones

Shipped so far:

- [x] Server-owned sessions (queue creates/stops the Reactor session)
- [x] Hibernation-ready storage model for production-scale rooms
- [x] Admin dashboard (watch the room, kick members, close sessions)

## License

[Apache 2.0](./LICENSE) © 2026 Reactor Technologies, Inc.

See [NOTICE](./NOTICE) for attribution requirements and
[CONTRIBUTING.md](./CONTRIBUTING.md) for the contributor sign-off (DCO) policy.
