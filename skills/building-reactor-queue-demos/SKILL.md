---
name: building-reactor-queue-demos
description: Build a queued, time-boxed Reactor demo with @reactor-team/queue — a PartyKit waiting-room server plus a JS/React client that admits N users at a time, has the server own session creation, mints short-lived Reactor JWTs only to admitted users, and releases sessions when time runs out. Use when adding a queue/waiting-room in front of a Reactor model, gating a viral launch, time-limiting demo sessions, migrating a non-queued Reactor app to a queued one, building an operator/admin dashboard for a queue, delegating session creation to another service (sessions sourced elsewhere or with another client already attached), or debugging queue admission, claim/session_ready, token minting, hibernation, or React autoConnect/StrictMode issues with the Reactor SDK.
---

# Building Reactor demos with `@reactor-team/queue`

A utility that puts a **virtual waiting room** in front of a Reactor model. Built
**on top of** the public Reactor REST API — it does not fork or replace the SDK.
Read this before adding a queue to an app or changing the queue packages.

## Why a queue exists (the problem it solves)

A Reactor session holds a **GPU** for its whole duration. GPUs are finite, so a
public demo has a hard concurrency ceiling. During a viral launch thousands
arrive at once:

- Without gating, every visitor calls `POST /sessions`, blows past quota, gets
  `429`/`402`, and sees a broken demo. First impressions are wasted.
- With a queue, only `N` users are ever live; everyone else waits in an orderly,
  position-aware line and is admitted automatically as capacity frees. Each user
  gets a bounded turn (e.g. 120s) so the line keeps moving.

It converts "demo is down, try later" into "you're #42, ~6 min" — busy-but-working
instead of broken.

## Two levels of using this — pick the smallest that fits

The single most important thing for building on this well: **most demos only need
the high-level path.** Reach for advanced features only when you have the specific
need. Don't wire admin mode or lifecycle overrides "just in case."

| You want…                                                                                                                                  | Level                             | What you touch                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Gate a model behind a line, time-box turns                                                                                                 | **High-level**                    | `createReactorQueueServer({ model, maxSessions })` + `<ReactorQueueProvider>` + `useReactorQueue()`. Nothing else. |
| Log/measure admissions, sessions, errors                                                                                                   | High-level + **hooks**            | `hooks: { onUserEnteredSession, onSessionClosed, … }`                                                              |
| An operator dashboard (watch line, kick users, force-close)                                                                                | **Advanced: admin mode**          | `RQ_ADMIN_PASSWORD` + `ReactorQueueAdminProvider` / `useReactorQueueAdmin`                                         |
| Sessions come from **another service**, not `POST /sessions` (pre-provisioned pool, or a session that already has another client attached) | **Advanced: lifecycle overrides** | `acquireSession` / `releaseSession`                                                                                |
| >1 user sharing one Reactor session                                                                                                        | **Advanced: multi-connection**    | `usersPerSession` (server mints a connection per member; platform caps `connections_per_session` at 4 by default)  |
| Tens of thousands of concurrent waiters                                                                                                    | **Operational**                   | hibernation is already on; understand the single-room ceiling                                                      |

If your task is "put a queue in front of model X", you are in the High-level row.
Stop there.

## The mental model

```
Browser (your app)                   PartyKit room (you deploy)            Reactor Coordinator
@reactor-team/queue                  @reactor-team/queue/server            api.reactor.inc
  • partysocket (ws)  ───────────▶     • FIFO queue + capacity gate   ──────▶  POST /sessions       (on claim)
  • getJwt() resolver  ◀── token ──    • mints JWTs + connections             POST .../connections (on claim)
  • sessionId+connectionId             • per-member timers (alarm)            POST /tokens
        │ getJwt + sessionId + connectionId                                   GET/DELETE /sessions/{id}
        ▼
@reactor-team/js-sdk  ──────────── WebRTC ────────────────────────────────▶  GPU / model
```

The PartyKit room is the **single source of truth**:

1. Lines users up FIFO and reserves a **capacity slot** for the head, filling an
   open slot before opening a new one, bounded by `maxSessions × usersPerSession`.
   At admission **no Reactor session exists yet.**
2. When the user **`claim()`s**, the server obtains a session id (default:
   `POST /sessions`) **and mints a WebRTC connection under it**
   (`POST .../connections`), then sends `session_ready { sessionId, connectionId }`.
   The client attaches with `connect(jwt, { sessionId, connectionId })`. Creating
   on claim — not on admission — means an abandoned grace window never orphans a
   GPU session. The mint is the real capacity test: a 429 (session at its
   `connections_per_session` cap) makes the queue spill the member to another or
   new session.
3. **Mints session-scoped JWTs** only for admitted members (the `getJwt`
   resolver). Each member gets their own token (`authorization_details`, matched
   to the configured model) bound at mint to the one session they were seated
   on, so members sharing a slot hold distinct tokens. Binding works against a
   session that already exists, so tokens stay short-lived and `request_token`
   re-mints. A member still in the grace window has no session yet and receives
   their token at claim. There is no unscoped fallback: an `acquireSession`
   override must source sessions from the same **user** as the API key, or the
   mint is refused and members get `token_mint_failed`.
4. **Bounded turns** (default 120s after claim). On the last member leaving, the
   session is released (default: `DELETE /sessions/{id}`). The **server is the
   sole stopper** — adopting clients never `DELETE`, so a tab closing leaves the
   session alive for other members and the queue decides when it ends.
5. Frees a member on `session_ended`, socket close, grace timeout, a poll that
   sees a terminal Reactor session state, **or** a per-member liveness sweep that
   releases a member whose PartyKit WS vanished without a clean `onClose`.

**Slot vs session vs member** (the core nouns):

- **Slot** — a capacity reservation. Holds up to `usersPerSession` members and
  lazily owns one Reactor session (created on the first member's claim).
- **Member** — one admitted connection, with its own grace/claim timer.
- **Queue** — waiting connections, stored one key per waiter (O(1), unbounded).

## Packages

**One package, `@reactor-team/queue`, with subpath entry points** — install it in
both the web app and the PartyKit project (often the same repo) and import the half
you need. There is no separate `-server` or `-protocol` package.

| Import                                        | Where it runs         | What                                               |
| --------------------------------------------- | --------------------- | -------------------------------------------------- |
| `@reactor-team/queue`                         | your web app          | `ReactorQueueClient` (framework-agnostic core)     |
| `@reactor-team/queue/react`                   | your web app          | `ReactorQueueProvider` + hooks (`useReactorQueue`) |
| `@reactor-team/queue/server`                  | your PartyKit project | `createReactorQueueServer`                         |
| `@reactor-team/queue/admin` · `…/admin/react` | your admin UI         | admin client + React layer                         |
| `@reactor-team/queue/protocol`                | both (rarely direct)  | wire message types + defaults                      |

`react`/`zustand` and `partykit` are **optional peer deps** — only the surfaces you
import pull them in.

## What the queue automates (the Reactor pieces)

You never call these directly — the queue does:

- **Token minting**: `POST /tokens` with `Reactor-API-Key: rk_...`,
  `{"expires_after": <seconds>}`, and (for member tokens) session
  `authorization_details` carrying `resources.sessions.bind` — the member's JWT
  is scoped to the configured model and bound to their one session → `{ jwt,
expires_at }`. The API key is a **server secret**; the browser only ever sees
  minted, scoped JWTs.
- **Session lifecycle**: with a queue the **server** owns the session and the SDK
  **attaches** via `connect(jwt, { sessionId, connectionId })`. States
  `CREATED → PENDING → WAITING → ACTIVE → INACTIVE → CLOSED`. No webhook for end —
  the queue polls `GET /sessions/{id}/runtime` (`CLOSED`/`INACTIVE` = free).
- **Connection minting**: `POST /sessions/{id}/transport/webrtc/connections` →
  `{ connection_id }`, one per member, so the queue controls every connection.
  The platform caps `connections_per_session` at **4 by default**; for
  `usersPerSession > 4` raise that account quota or the mint 429s and the queue
  spills to another session. A connection is reaped automatically when the
  member's WebRTC disconnects (the model fires a per-connection disconnect).
- **Stopping**: `DELETE /sessions/{id}`, the queue's job alone. Adopting clients
  never `DELETE` (the SDK only deletes sessions it created itself), so the queue
  is the single stopper. Keep `stopSessionsOnExpiry` on — there is no client-side
  fallback. The queue holds its own admin JWT for this.

---

# High-level path (most demos)

## 1. Server — a PartyKit room

Configure the queue in code — `createReactorQueueServer({...})` is the one place.
`partykit.json` is plumbing; secrets live in `.env`.

```ts
// partykit/server.ts
import { createReactorQueueServer } from "@reactor-team/queue/server";

export default createReactorQueueServer({
  model: "helios",
  maxSessions: 3,
  sessionDurationMs: 120_000,
});
```

```jsonc
// partykit.json — PartyKit plumbing only; no queue config here.
{
  "name": "my-demo-queue",
  "main": "partykit/server.ts",
  "compatibilityDate": "2024-11-01",
}
```

```bash
echo "RQ_REACTOR_API_KEY=rk_your_key_here" >> .env   # secret; partykit dev auto-loads .env
npx partykit dev
npx partykit deploy --with-vars                       # uploads the .env secret → my-demo-queue.<user>.partykit.dev
```

## 2. Client — gate the app (React)

```tsx
import { ReactorQueueProvider, useReactorQueue } from "@reactor-team/queue/react";
import { ReactorProvider } from "@reactor-team/js-sdk";

function App() {
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
        #{q.position} of {q.total}
      </p>
    );
  if (q.phase === "admitted") return <button onClick={q.claim}>Enter</button>;
  if (q.phase === "starting") return <p>Starting…</p>; // claimed, session being created
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

function SessionBridge() {
  const { endSession } = useReactorQueue();
  React.useEffect(() => () => endSession(), [endSession]);
  return null;
}
```

The whole integration is `getJwt={q.getJwt}` plus `connectOptions.sessionId` and
`connectOptions.connectionId` — both arrive in `session_ready`, exposed as
`q.sessionId` / `q.connectionId` once `phase === "active"`. Pass **both**:
omitting `sessionId` makes the SDK create+own+delete its own session, bypassing
the queue. Requires `@reactor-team/js-sdk` **2.12.0+** (for `ConnectOptions.connectionId`).

A complete runnable version is `examples/basic/app/page.tsx` (one page, base SDK,
countdowns, its own PartyKit room). Use it as the reference.

## Client API surface

`<ReactorQueueProvider {...ReactorQueueClientOptions}>` then:

- `useReactorQueue()` → full `QueueState` + actions: `connect`, `leave`, `rejoin`,
  `claim`, `endSession`, `getJwt`.
- `useQueueSelector(s => s.position)` → subscribe to one slice (fewer renders).
- `useQueueActions()` / `useReactorQueueClient()` → actions / raw client.

Vanilla (no React): `new ReactorQueueClient({ host, autoConnect: true })`, then
`client.subscribe(s => ...)`, `client.getJwt`, `s.sessionId` for attach,
`client.claim()`, `client.leave()`.

### Phases (`QueueState.phase`)

`idle → connecting → queued → admitted → starting → active → expired`, plus
`rejected` (duplicate tab; auto-retries) and `disconnected` (dropped socket).

| Phase        | Meaning                                                   | Typical UI                    |
| ------------ | --------------------------------------------------------- | ----------------------------- |
| `connecting` | socket opening                                            | spinner                       |
| `queued`     | in line                                                   | "#{position} of {total}"      |
| `admitted`   | capacity slot reserved, grace ticking. **No session yet** | "Enter" + grace countdown     |
| `starting`   | claimed; server is creating the session + connection      | "Starting…" spinner           |
| `active`     | `session_ready`; `sessionId` + `connectionId` set         | the model + session countdown |
| `expired`    | time up / reclaimed; session released                     | "Rejoin" prompt               |
| `rejected`   | duplicate tab                                             | "open in one tab"             |

`idle` means "not in the queue" — the SAME state whether the user never joined or
just left. There is intentionally no `left` phase; track "you left — rejoin?" in
**app state** (see the `exited` flag in `examples/basic/app/page.tsx`).

`sessionId` is `null` until `active`. Always gate `<ReactorProvider>` on
`phase === "active" && sessionId`.

### State fields

`position`, `total`, `active`, `capacity`, `token`, `tokenExpiresAt` (unix s),
`sessionEndsAt` (unix ms — grace deadline while `admitted`, session deadline while
`active`), `sessionDurationMs`, `secondsLeft` (set on the pre-expiry warning),
`sessionId`, `reason`. Build countdowns off `sessionEndsAt`.

## Configuration (server)

Configure in code via `createReactorQueueServer({...})`; each option also reads
from an env var that overrides the code value (per-deploy tuning). Resolution
order: **built-in default → `createReactorQueueServer({...})` → env var** (env
wins). The API key MUST come from a secret, never code.

| Env var                          | Config key                  | Default                   | Purpose                                      |
| -------------------------------- | --------------------------- | ------------------------- | -------------------------------------------- |
| `RQ_REACTOR_API_KEY`             | `apiKey`                    | — (**required**, secret)  | mint JWTs; create/stop sessions              |
| `RQ_MODEL`                       | `model`                     | — (**required**)          | model for `POST /sessions`                   |
| `RQ_MAX_SESSIONS`                | `maxSessions`               | `1`                       | concurrent Reactor sessions                  |
| `RQ_USERS_PER_SESSION`           | `usersPerSession`           | `1`                       | members per session                          |
| `RQ_SESSION_DURATION_MS`         | `sessionDurationMs`         | `120000`                  | session budget after claim                   |
| `RQ_ADMISSION_GRACE_MS`          | `admissionGraceMs`          | `45000`                   | time to claim a reserved slot                |
| `RQ_WARNING_BEFORE_MS`           | `warningBeforeMs`           | `30000`                   | lead time for `time_warning`                 |
| `RQ_TOKEN_TTL_SECONDS`           | `tokenTtlSeconds`           | `60`                      | minted JWT lifetime (keep short)             |
| `RQ_POLL_INTERVAL_MS`            | `pollIntervalMs`            | `15000`                   | session reconciliation cadence               |
| `RQ_COORDINATOR_URL`             | `coordinatorUrl`            | `https://api.reactor.inc` | Reactor API base                             |
| `RQ_API_VERSION`                 | `apiVersion`                | `1`                       | `Reactor-API-Version` header                 |
| `RQ_STOP_SESSIONS`               | `stopSessionsOnExpiry`      | `true`                    | `DELETE` session on expiry (default release) |
| `RQ_ALLOW_DUPLICATE_CONNECTIONS` | `allowDuplicateConnections` | `false`                   | allow same browser in multiple tabs          |
| `RQ_ADMIN_PASSWORD`              | `adminPassword`             | — (off)                   | enables admin mode (see below)               |

Tuning intuition: throughput ≈ `(maxSessions × usersPerSession) / sessionDurationMs`.
Shorter sessions / more slots move the line faster but cost more GPU.
`tokenTtlSeconds` is independent of the grace window: a member's token is minted
against the session they claim, so it starts counting from claim, not admission.

### Hooks (observe-only; not env-configurable)

Pass `hooks: { … }` to `createReactorQueueServer`. Use these for logging/metrics —
they never change behavior. Keep them fast and non-throwing.

| Hook                                      | Fires when                                           |
| ----------------------------------------- | ---------------------------------------------------- |
| `onUserConnected(connId)`                 | a connection joined the queue                        |
| `onUserDisconnected(connId)`              | a connection's socket closed                         |
| `onUserEnteredSession(connId, sessionId)` | a member **claimed** and got a session               |
| `onSessionCreated(sessionId)`             | a session was acquired for a slot (first claim)      |
| `onSessionClosed(sessionId, reason)`      | the last member left; slot/session torn down         |
| `onError(where, error)`                   | a non-fatal server error (mint, acquire, release, …) |

## Client config (`ReactorQueueClientOptions` / provider props)

`host` (required), `room`, `party`, `clientId`, `autoConnect` (provider default
`true`), `tokenSkewMs`, `tokenRequestTimeoutMs`, `retryRejectedMs`.

---

# Advanced: session lifecycle overrides (delegate to another service)

**When to use:** the queue should _not_ own session creation. Two common shapes:

- Sessions are **pre-provisioned by another service** (a warm pool) and the queue
  should **lease** one instead of calling `POST /sessions`.
- Each session already has **another kind of client attached** before the queued
  user arrives (a non-interactive participant, an agent/bot, a teleoperated peer);
  the queue hands the user into an existing session rather than a fresh one.

If you just want a queue in front of a model, **skip this** — the default
create/delete behavior is correct.

Two overridable callbacks (code-only, not env). Default = create/delete via the
Reactor API:

```ts
createReactorQueueServer({
  model: "helios",

  // Obtain a session id on the first claim of a slot. Default: POST /sessions.
  // Override to lease one from your service. Throw if none available → the client
  // gets an `error` and can retry.
  acquireSession: async ({ model }) => {
    const r = await fetch(`${SERVICE}/lease`, { method: "POST", body: JSON.stringify({ model }) });
    return (await r.json()).session_id;
  },

  // A user LEFT the session. NOT a "delete" primitive — you decide. You get who
  // left (`userId`) and whether they were the `lastMember`. Default: when the last
  // member leaves, DELETE the session (subject to stopSessionsOnExpiry).
  releaseSession: async ({ sessionId, userId, reason, lastMember }) => {
    if (lastMember) await fetch(`${SERVICE}/recycle/${sessionId}`, { method: "POST" });
  },
});
```

Mental model for these:

- **The queue owns all tracking** (slots, members, the queue) in Durable Object
  storage. Your callbacks never touch it — `acquire` returns an id, the queue
  stores it; `release` is a notification, the queue removes the member/slot itself.
  There is **no synchronization to do** inside the callbacks.
- **`acquire` runs once per session** (first member's claim), never during grace.
- **Every session-stop path funnels through `release`** — a member timing out, a
  disconnect, `endSession()`, an admin "Close session", an admin kick, and the
  reconcile poll all call `releaseSession`. Branch on `lastMember` to decide
  whether the session dies or stays for remaining participants.
- **Make callbacks idempotent.** Overrides do network I/O; the DO input gate is
  open across non-storage awaits, so other events run concurrently. `release` may
  be called for an already-dead session, and the queue does **not** retry your
  side effects (errors surface via `onError`, then it moves on). The queue guards
  its own consistency (storage-gated, plus a `claiming` marker that blocks a
  duplicate claim from acquiring twice), but your service must tolerate retries
  and stale calls.
- **Account + connections:** a custom-acquired session must belong to the **same
  Reactor account** as the queue's API key (so the minted JWT can attach). If
  another client shares the session with the queued user, the platform must allow
  more than one connection per session.

---

# Advanced: admin mode (operator dashboard)

**When to use:** you want a human operator to watch the live room and intervene
(kick a stuck user, force-close a session, see config) — for an internal ops page
or a launch war-room. A normal demo does not need this.

The library ships the **transport + state**; you build (or copy) the UI.

## Enabling it (server)

Set `RQ_ADMIN_PASSWORD` (or `adminPassword`). When unset, admin connections are
rejected. Keep it a **server secret** in `.env` — never in `partykit.json`, never
in `NEXT_PUBLIC_*`.

## Protocol (what flows over the socket)

Connect with `?rqAdmin=1` (this connection is **not** queued), then send
`{ type: "admin_auth", password }`. The server replies `admin_ready`, then pushes
an `admin_snapshot` on **every room change** (and on a poll, if you set one). The
snapshot has `config`, `queue`, `slots`/`sessions`, and `members`. Admin actions:

- `admin_kick_member` — evict an admitted user (releases their session seat)
- `admin_kick_queued` — drop a still-waiting connection from the line
- `admin_close_session` — force-close a session (releases all its members)
- `admin_refresh` — request a fresh snapshot

### Activity log

The server also streams a structured event log: `admin_log_history` (recent
buffer, once after auth) then a live `admin_log` per event. The client merges
both into `useReactorQueueAdmin().logs` (`AdminLogEntry[]`, oldest → newest). Each
entry has `level` / `event` / `message` and optional `connId` / `sessionId` /
`data`. Critically, a failed Reactor API call (e.g. a **quota rejection** on
`POST /sessions`) is logged at `error` with the HTTP status and body in `data` —
so "why won't it create more sessions?" is answerable from the dashboard. Server
events are written via one `log()` helper and always hit the server console. With
admin mode on, **all** levels stream live to admins, but only `warn`/`error` are
persisted to the (hibernation-safe) ring buffer that seeds history — `info` is
stream-only, so the high-frequency connect/disconnect hot path never touches
storage. Connection rejections are console-only and never feed the stream/storage.

## React (build your own UI)

```tsx
import { ReactorQueueAdminProvider, useReactorQueueAdmin } from "@reactor-team/queue/admin/react";

<ReactorQueueAdminProvider
  host={PARTYKIT_HOST}
  password={password} // string OR async () => string (env, prompt, your auth — you decide)
  refreshIntervalMs={10_000} // optional poll to keep msLeft countdowns live; server still pushes on change
>
  <Dashboard />
</ReactorQueueAdminProvider>;

function Dashboard() {
  const { phase, snapshot, logs, kickMember, kickQueued, closeSession, refresh } =
    useReactorQueueAdmin();
  if (phase !== "ready" || !snapshot) return <p>Connecting…</p>;
  // snapshot.config / snapshot.queue / snapshot.members / snapshot.sessions
  // logs: AdminLogEntry[] — render newest-first; expand entry.data on errors
}
```

- `password` is a **resolver you control** — hardcode, read from a field, call your
  own auth. The library doesn't prescribe how operators authenticate to _your_ page;
  it only checks the value against `RQ_ADMIN_PASSWORD`.
- Hooks: `useReactorQueueAdmin()` (state + actions), `useAdminSelector(s => …)`,
  `useAdminActions()`, `useReactorQueueAdminClient()`.
- Vanilla: `@reactor-team/queue/admin` exports `ReactorQueueAdminClient`
  (`subscribe`, `kickMember`, `kickQueued`, `closeSession`, `refresh`).

## Starting from the existing dashboard

`examples/basic/app/admin/page.tsx` is a complete, styled dashboard: a password
gate, a config card beside big-number stats (waiting / live / connected / active
sessions), a per-session panel with per-user **Evict** and **Close session**, and
the waiting list with per-user eviction. Copy it and restyle, or build fresh from
`useReactorQueueAdmin()` — the snapshot shape is all you need.

---

# Operational: scaling & hibernation

You rarely configure this, but understand it before shipping to many users.

- The server opts into PartyKit **Hibernation** (`options.hibernate = true`): the
  platform holds open sockets while your server instance sleeps between messages,
  lifting a room from ~100 to **~32k connections** and dropping idle cost to ~zero.
- It's written for it: **all state is in `room.storage`**, there's **no app-level
  heartbeat** (liveness comes from the platform), broadcasts flush inside the
  handler turn (no in-memory timers), and **alarms are only scheduled while
  members/slots exist** so an empty room fully sleeps.
- An **open connection does not keep the room awake** — only messages and alarms
  do. Thousands of idle waiters cost nothing; an admin refreshing every 10s just
  wakes the room briefly each tick (cost, not capacity).
- **One room = one Durable Object = ~32k connections.** Past that you need
  multiple rooms + a capacity coordinator (sharding) — a larger effort, not a flag.
- **`partykit dev` never hibernates** — validate hibernation/scaling on a deployed
  instance, not locally.

---

# Migrating a non-queued Reactor app → queued

A non-queued app mints its own token and passes a resolver to the SDK:

```tsx
// BEFORE: app/api/reactor/token/route.ts hits POST /tokens with the API key:
<ReactorProvider modelName="helios" getJwt={fetchToken} />
```

1. **Stand up the queue server** — a PartyKit project with
   `createReactorQueueServer({ model })`; move `REACTOR_API_KEY` to the
   `RQ_REACTOR_API_KEY` secret and **delete the token route** (the queue mints now).
2. **Wrap the app** in `<ReactorQueueProvider host={...}>`, render `<ReactorProvider>`
   only once `phase === "active"`.
3. **Swap the resolver**: `getJwt={fetchToken}` → `getJwt={queue.getJwt}`.
4. **Attach, don't create**: `connectOptions={{ sessionId: queue.sessionId, connectionId: queue.connectionId }}`;
   `SessionBridge` calls `endSession()` on unmount. (Delete the old client-side
   `DELETE /sessions` teardown — the queue is the sole stopper now.)

The API key leaves the browser-facing app entirely, sessions become time-boxed,
and access is gated by the line. The model UI is unchanged.

# React footguns (read before you ship)

### 1. `autoConnect` + React StrictMode = connect/disconnect race

StrictMode (Next.js dev default) double-invokes effects. `<ReactorProvider
autoConnect>` then races `connect()` against a cleanup `disconnect()` →
`TypeError: …reading 'pollSessionReady'`, and the spurious `SessionBridge` unmount
frees the slot. Production never double-mounts. **Fix:** `reactStrictMode: false`
(what `examples/basic` does) OR drop `autoConnect` and connect via a button.

### 2. Keep `getJwt` referentially stable

`useReactorQueue().getJwt` is already stable — pass it directly. Never wrap it in
a fresh inline arrow (`getJwt={() => q.getJwt()}`); that churns the session.

### 3. `endSession()` frees the slot — only on real exit

`SessionBridge`'s unmount `endSession()` tells the server the user left and slides
the queue. Don't call it on transient state changes (and avoid the StrictMode
combo that triggers it spuriously).

### 4. The token is short-lived by design

60s default; the client auto-refreshes and keeps the last cached token through
teardown so any in-flight SDK call still resolves one. (The adopting client never
issues `DELETE /sessions` — the server stops the session — so the token isn't
needed for teardown, just for clean shutdown of in-flight requests.) Don't raise
`RQ_TOKEN_TTL_SECONDS` to "avoid refresh" — short tokens are the security model.

### 5. Reconnects change the connection id

PartySocket reconnects with a new connection id; a mid-session WS reconnect
re-enters the line. Keep sessions short and the socket healthy; the server's poll
reconciles state.

# Working on the queue packages themselves

- `packages/queue/src/protocol.ts` holds the wire types + defaults — change here
  first when adding a message; client and server both import it so they can't drift.
- One package, `packages/queue/`, with subpath builds (tsup entries for `index`,
  `react`, `admin-client`, `admin-react`, `server/index`, `protocol`); the exports
  map in `package.json` wires each to its `dist/…` output.
- Server is one PartyKit `Server` class (`src/server/`). Storage keys: `q:<seq>` + `qpos:<connId>`
  - `qseq`/`qcount` (the ordered queue), `member:<connId>`, `slot:<slotId>`,
    `cid:`/`conn:` (client mapping), `admin:<connId>`. Timers are alarm-driven.
- All session-end paths funnel through `runRelease`; all session-acquire through
  `runAcquire`. Don't add a second `stopSession`/`createSession` call site.
- Build/verify: `pnpm build` (tsup), `pnpm typecheck`. Boot with `npx partykit dev`
  and `curl http://127.0.0.1:1999/parties/main/<room>` for live room state (500s
  if `RQ_REACTOR_API_KEY` didn't resolve). Hibernation only shows on deploy.
- Single-threaded per room, but storage gates only close around storage ops — code
  that `await`s a network call can be interleaved; guard every `send()` and keep
  read-modify-write sequences storage-backed.

# Resources

- `README.md` — full library reference and architecture.
- `examples/basic` — runnable demo (`app/page.tsx`) + admin dashboard
  (`app/admin/page.tsx`) + its PartyKit room (`partykit/server.ts`).
- `deploy-partykit` skill — when the demo's ready, deploy its PartyKit room to
  Cloudflare (cloud-prem).
