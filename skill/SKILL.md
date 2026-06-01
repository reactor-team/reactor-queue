---
name: building-reactor-queue-demos
description: Build a queued, time-boxed Reactor demo with @reactor-team/queue — a PartyKit waiting-room server plus a JS/React client that admits N users at a time, mints short-lived Reactor JWTs only to admitted users, and stops sessions when their time runs out. Use when adding a queue/waiting-room in front of a Reactor model, gating a viral launch, time-limiting demo sessions, migrating a non-queued Reactor app to a queued one, or debugging queue admission, token minting, session stopping, or React autoConnect/StrictMode issues with the Reactor SDK.
---

# Building Reactor demos with `@reactor-team/queue`

This repo is a utility that puts a **virtual waiting room** in front of a
Reactor model. It is built **on top of** the public Reactor REST API — it does
not fork or replace the SDK. Read this guide before adding a queue to an app or
changing the queue packages themselves.

## Why a queue exists (the problem it solves)

A Reactor session holds a **GPU** for its whole duration. GPUs are finite, so a
public demo has a hard concurrency ceiling. During a viral launch, thousands
arrive at once:

- Without gating, every visitor would call `POST /sessions`, blow past quota, get
  `429`/`402`, and sees a broken demo. First impressions are wasted.
- With a queue, only `N` users are ever live; everyone else waits in an orderly,
  position-aware line and is admitted automatically as slots free. Each user
  gets a bounded turn (e.g. 120s) so the line keeps moving.

The queue converts "demo is down, try later" into "you're #42, ~6 min" — which
is what makes a launch feel busy-but-working instead of broken, and is the
single most common thing teams hand-roll for a launch.

## The mental model

```
Browser (your app)                   PartyKit room (you deploy)            Reactor Coordinator
@reactor-team/queue                  @reactor-team/queue-server            api.reactor.inc
  • partysocket (ws)  ───────────▶     • FIFO queue + session cap    ──────▶  POST /sessions
  • getJwt() resolver  ◀── token ──    • mints JWTs; creates sessions         POST /tokens
  • sessionId on admit                 • per-member timer (alarm)              GET/DELETE /sessions/{id}
        │ getJwt + sessionId
        ▼
@reactor-team/js-sdk  ──────────── WebRTC ────────────────────────────────▶  GPU / model
```

The PartyKit room is the **single source of truth**:

1. Lines users up FIFO; fills open sessions before `POST /sessions` up to
   `maxSessions` × `usersPerSession` total members.
2. **Creates the Reactor session on admission** and sends `sessionId` in
   `admitted` so the client uses `connect({ sessionId })` (no client-side create).
3. **Mints short-lived JWTs** only for admitted members (`getJwt` resolver).
4. **Bounded turns** (default 120s after `claim()`). On expiry / empty session,
   `DELETE /sessions/{id}` stops the GPU.
5. Frees a member on `session_ended`, socket close, grace timeout, or poll
   seeing a terminal Reactor session state.

## Packages

| Package | Where it runs | Import |
|---|---|---|
| `@reactor-team/queue-server` | your PartyKit project | `createReactorQueueServer` |
| `@reactor-team/queue` | your web app | `ReactorQueueClient` (core), `@reactor-team/queue/react` (Provider + hooks) |
| `@reactor-team/queue-protocol` | transitive | wire message types + defaults |

## How the public Reactor pieces work (what the queue automates)

You normally never call these directly — the queue does — but understand them:

- **Token minting**: `POST /tokens` with header `Reactor-API-Key: rk_...` and
  body `{"expires_after": <seconds>}` → `{ "jwt", "expires_at" }`. TTL is
  requestable and capped server-side (max ~6h). The API key is a **server
  secret**; the browser only ever sees minted JWTs.
- **Session lifecycle**: normally the SDK's `connect()` calls `POST /sessions`;
  with a queue, the **server** creates the session and the SDK **attaches** via
  `connect(jwt, { sessionId })`. States:
  `CREATED → PENDING → WAITING → ACTIVE → INACTIVE → CLOSED`. There is **no
  webhook** for session end — you detect it by polling `GET /sessions/{id}/runtime`
  (read `state`; `CLOSED`/`INACTIVE` mean the slot is free).
- **Stopping a session**: `DELETE /sessions/{id}` closes it in any state and
  frees the GPU. The queue server holds its own admin JWT (minted from the same
  key) to GET/DELETE the sessions clients report to it.

So the queue's job is: create sessions, mint short JWTs, hand `sessionId` to
clients, and stop/reap when members leave or time runs out.

## Make a demo with it (quickstart)

### 1. Server — a PartyKit room

```ts
// partykit/server.ts
import { createReactorQueueServer } from "@reactor-team/queue-server";
export default createReactorQueueServer({ model: "helios", maxSessions: 3 });
```

```jsonc
// partykit.json — non-secret tunables live in `vars`
{ "name": "my-demo-queue", "main": "partykit/server.ts",
  "compatibilityDate": "2024-11-01",
  "vars": { "RQ_MODEL": "helios", "RQ_MAX_SESSIONS": "3", "RQ_SESSION_DURATION_MS": "120000" } }
```

```bash
# local: `partykit dev` auto-loads .env from the project dir onto room.env
echo "RQ_REACTOR_API_KEY=rk_your_key_here" >> .env
npx partykit dev
# deploy: --with-vars uploads the secrets from .env
npx partykit deploy --with-vars              # → my-demo-queue.<user>.partykit.dev
# (or store it once: `npx partykit env add RQ_REACTOR_API_KEY`, then `npx partykit deploy`)
```

### 2. Client — gate the app (React)

```tsx
import { ReactorQueueProvider, useReactorQueue } from "@reactor-team/queue/react";
import { ReactorProvider, useReactor } from "@reactor-team/js-sdk";

function App() {
  return (
    <ReactorQueueProvider host={process.env.NEXT_PUBLIC_PARTYKIT_HOST!}>
      <Gate />
    </ReactorQueueProvider>
  );
}

function Gate() {
  const q = useReactorQueue();
  if (q.phase === "queued")   return <p>#{q.position} of {q.total}</p>;
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

function SessionBridge() {
  const { endSession } = useReactorQueue();
  React.useEffect(() => () => endSession(), [endSession]);
  return null;
}
```

Integration: `getJwt={q.getJwt}` and `connectOptions.sessionId` from queue state
(set on `admitted`). Requires `@reactor-team/js-sdk` with `ConnectOptions.sessionId`.

A complete, runnable version (single page, base SDK, queue overlay + countdown
timers, its own PartyKit room) lives in `examples/basic` — `app/page.tsx` is the
whole thing. Use it as the reference implementation.

## Client API surface

`<ReactorQueueProvider {...ReactorQueueClientOptions}>` then:

- `useReactorQueue()` → full `QueueState` + actions: `connect`, `leave`,
  `rejoin`, `claim`, `endSession`, `getJwt`.
- `useQueueSelector(s => s.position)` → subscribe to one slice (fewer renders).
- `useQueueActions()` / `useReactorQueueClient()` → actions / raw client.

Vanilla (no React): `new ReactorQueueClient({ host, autoConnect: true })`, then
`client.subscribe(s => ...)`, `client.getJwt`, `s.sessionId` for attach,
`client.claim()`, `client.leave()`.

### Phases (`QueueState.phase`)

`idle → connecting → queued → admitted → active → expired`, plus `rejected`
(duplicate tab; auto-retries) and `disconnected` (dropped socket).

| Phase | Meaning | Typical UI |
|---|---|---|
| `connecting` | socket opening | spinner |
| `queued` | in line | "#{position} of {total}" |
| `admitted` | slot reserved, token ready, grace ticking | "Enter" + grace countdown |
| `active` | claimed; session should be running | the model + session countdown |
| `expired` | time up / reclaimed; session stopped | "Rejoin" prompt |
| `rejected` | duplicate tab | "open in one tab" |

`idle` means "not in the queue" — it is the SAME state whether the user never
joined or just left. The Queue SDK intentionally has no separate `left` phase;
if you want a "you left — rejoin?" screen, track that in **app state** (see the
`exited` flag in `examples/basic/app/page.tsx`). Do not add a `left` phase to
the SDK.

### State fields worth knowing

`position`, `total`, `active`, `capacity`, `token`, `tokenExpiresAt`
(unix s), `sessionEndsAt` (unix ms — the grace deadline while `admitted`, the
session deadline while `active`), `sessionDurationMs`, `secondsLeft` (set on the
pre-expiry warning), `sessionId`, `reason`.

Build countdowns off `sessionEndsAt`: while `admitted` it counts the
admission-grace window ("time to enter"); while `active` it counts the session.

## Configuration (server)

Resolution order: **built-in default → `createReactorQueueServer({...})` → env
var** (env wins, for redeploy-free tuning). The API key MUST come from a secret.

| Env var | Config key | Default | Purpose |
|---|---|---|---|
| `RQ_REACTOR_API_KEY` | `apiKey` | — (**required**, secret) | mint JWTs; stop sessions |
| `RQ_MODEL` | `model` | — (**required**) | model for `POST /sessions` |
| `RQ_MAX_SESSIONS` | `maxSessions` | `1` | concurrent Reactor sessions |
| `RQ_USERS_PER_SESSION` | `usersPerSession` | `1` | members per session |
| `RQ_SESSION_DURATION_MS` | `sessionDurationMs` | `120000` | session budget after claim |
| `RQ_ADMISSION_GRACE_MS` | `admissionGraceMs` | `45000` | time to claim a reserved slot |
| `RQ_WARNING_BEFORE_MS` | `warningBeforeMs` | `30000` | lead time for `time_warning` |
| `RQ_TOKEN_TTL_SECONDS` | `tokenTtlSeconds` | `60` | minted JWT lifetime (keep short) |
| `RQ_POLL_INTERVAL_MS` | `pollIntervalMs` | `15000` | session reconciliation cadence |
| `RQ_COORDINATOR_URL` | `coordinatorUrl` | `https://api.reactor.inc` | Reactor API base |
| `RQ_API_VERSION` | `apiVersion` | `1` | `Reactor-API-Version` header |
| `RQ_STOP_SESSIONS` | `stopSessionsOnExpiry` | `true` | `DELETE` session on expiry |

Hooks: `onUserConnected`, `onUserDisconnected`, `onUserEnteredSession`,
`onSessionCreated`, `onSessionClosed`, `onError`.

Tuning intuition: throughput ≈ `(maxSessions × usersPerSession) / sessionDurationMs`. Shorter
sessions and more slots move the line faster but cost more GPU and give each
user less time. `admissionGraceMs` must be < `tokenTtlSeconds` so the first
token is still valid when the user clicks Enter; both defaults satisfy this.

## Client config (`ReactorQueueClientOptions` / provider props)

`host` (required), `room`, `party`, `clientId`, `autoConnect` (provider default
`true`), `tokenSkewMs`, `tokenRequestTimeoutMs`,
`retryRejectedMs`.

## Migrating a non-queued Reactor app → queued

A typical non-queued app mints its own token via a server route and passes a
resolver to the SDK:

```tsx
// BEFORE: app/api/reactor/token/route.ts hits POST /tokens with the API key,
// and the client does:
<ReactorProvider modelName="lingbot" getJwt={fetchToken} />
```

Migrate in four steps:

1. **Stand up the queue server.** Add a PartyKit project with
   `createReactorQueueServer()` and move your `REACTOR_API_KEY` to the
   `RQ_REACTOR_API_KEY` PartyKit secret. **Delete the Next.js token route** —
   the queue mints JWTs now, so the key no longer lives in your web app.
2. **Wrap the app** in `<ReactorQueueProvider host={...}>` and only render
   `<ReactorProvider>` once `phase === "active"`.
3. **Swap the resolver**: `getJwt={fetchToken}` → `getJwt={queue.getJwt}`.
4. **Attach, don't create**: `connectOptions={{ sessionId: queue.sessionId }}`
   (from `admitted`). `SessionBridge` only calls `endSession()` on unmount.

Net effect: the API key leaves the browser-facing app entirely, sessions become
time-boxed, and access is gated by the line. The model UI itself is unchanged.

## React footguns (read before you ship)

These are the things that bite people wiring the SDK + queue together.

### 1. `autoConnect` + React StrictMode = connect/disconnect race

StrictMode (Next.js dev default) double-invokes effects: mount → cleanup →
remount. The Reactor SDK's `<ReactorProvider autoConnect>` starts `connect()` on
mount and `disconnect()` on cleanup. The double-invoke races a `connect()`
against a `disconnect()` that nulls the SDK's coordinator client mid-flight →

```
TypeError: Cannot read properties of undefined (reading 'pollSessionReady')
```

It also unmounts your `SessionBridge`, whose `endSession()` frees the slot, so
the remount's token request then times out. Production never double-mounts; this
is dev-only. **Fixes** (pick one): set `reactStrictMode: false` in your Next
config (simplest, what `examples/basic` does), OR drop `autoConnect` and connect
via an explicit button (what the SDK's own examples do). Never "fix" it by
retry-looping connect.

### 2. Keep `getJwt` referentially stable

The SDK provider tears down and reconnects when its `getJwt`/`jwtSource`
identity changes. `useReactorQueue().getJwt` is already stable (it's the same
client method across renders) — do **not** wrap it in a fresh inline arrow like
`getJwt={() => q.getJwt()}`, which creates a new function every render and can
churn the session.

### 3. `endSession()` frees the slot — only call it on real exit

`SessionBridge` calls `endSession()` on unmount, which tells the server the
user left and slides the queue. That's correct for "user navigated away". Don't
call it on transient state changes, and be aware StrictMode's spurious unmount
(footgun #1) triggers it — another reason to avoid the autoConnect+StrictMode
combo in dev.

### 4. The token is short-lived by design

Tokens default to 60s. The client refreshes them automatically (`getJwt` on
demand + a proactive warm-up before expiry) and hands the last cached token to
the SDK even during teardown so cleanup `DELETE`s succeed. Don't raise
`RQ_TOKEN_TTL_SECONDS` to "avoid refresh" — short tokens are the security model
(a leaked token expires in a minute). If you see `timed out waiting for a queue
token`, the cause is usually a freed slot (footgun #1/#3), not the TTL.

### 5. Reconnects change the connection id

PartySocket reconnects on transient drops with a new connection id. The stable
per-browser `clientId` (localStorage) handles duplicate-tab rejection, but a
mid-session WS reconnect re-enters the line. Keep sessions short and the socket
healthy; for long sessions, expect the server's poll
to reconcile state.

## Working on the queue packages themselves

- `packages/protocol` holds the wire types + defaults — change here first when
  adding a message; client and server both import it so they can't drift.
- Server logic is one PartyKit `Server` class (storage: `queue`, `member:<connId>`,
  `session:<reactorSessionId>`, `cid:`/`conn:`; alarm-driven timers).
- Build/verify: `pnpm build` (tsup, all packages), `pnpm typecheck`. Test the
  server boots with `npx partykit dev` (it auto-loads `.env`) and
  `curl http://127.0.0.1:1999/party/<room>` to dump live room state (the debug
  endpoint 500s if `RQ_REACTOR_API_KEY` didn't resolve).
- The PartyKit server is single-threaded per room, so handlers need no locking;
  but any `send()` can race a socket close — always guard sends.

## Resources

- `README.md` — full library reference and architecture.
- `examples/basic` — complete runnable demo in one page (`app/page.tsx`) + its
  own PartyKit room (`partykit/server.ts`).
