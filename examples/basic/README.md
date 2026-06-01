# Basic example

The smallest end-to-end demo: **one page** (`app/page.tsx`) puts the
[Helios](https://docs.reactor.inc) text-to-video model behind the queue. One
Next.js app + one PartyKit room.

It shows every queue phase — line position, the "you're up" admission countdown,
the live session with a time-left clock, expiry, and a rejoin prompt — plus the
two integration points: `getJwt={queue.getJwt}` and
`connectOptions={{ sessionId: queue.sessionId }}` so the SDK attaches to the
server-created session (no `reportSession`).

There is **no model-control UI**: as soon as the session is ready the page
auto-sends one prompt (the glowing words "REACTOR QUEUE") and starts generating,
so you get live video instead of a black screen. That's the whole point — adding
a queue doesn't change how you drive the model; swap `HeliosProvider` for any
typed SDK (or the base `Reactor`) and your existing controls work unchanged.

## Run it

The example pins `@reactor-team/js-sdk` via a root `pnpm.overrides` link to
`../js-sdk` so `connectOptions.sessionId` type-checks before that API ships on
npm (js-sdk PR #189). Remove the override once a release includes it.

From the **repo root** (build the workspace packages first):

```bash
pnpm install
pnpm --filter "./packages/*" build
```

Then:

```bash
cd examples/basic
cp .env.example .env
# edit .env: set RQ_REACTOR_API_KEY=rk_...
pnpm dev
```

- Next.js → http://localhost:3000 (demo) · http://localhost:3000/admin (dashboard)
- PartyKit → http://127.0.0.1:1999

Both processes read this folder's `.env`: Next.js for `NEXT_PUBLIC_*`, and
`partykit dev` loads it automatically (it prints `Loading environment variables
from .env`) and exposes `RQ_REACTOR_API_KEY` on `room.env`.

Open http://localhost:3000. You'll see your queue position; click **Enter the
demo** when you reach the front. Open a second browser to watch the line form
(keep `RQ_MAX_SESSIONS=1` in `partykit.json`).

## What to look at

- `app/page.tsx` — the entire example: `<ReactorQueueProvider>`, a phase switch,
  the gated `<ReactorProvider getJwt={queue.getJwt}>`, and `SessionBridge`.
- `partykit/server.ts` — `createReactorQueueServer()`, the whole queue.
- `partykit.json` — tunables (`RQ_MODEL`, `RQ_MAX_SESSIONS`, `RQ_USERS_PER_SESSION`, `RQ_ADMIN_PASSWORD`, …).
- `app/admin/page.tsx` — live queue dashboard (kick members, force-close sessions).

## Deploy

`partykit deploy --with-vars` pushes the secrets from your local `.env`:

```bash
pnpm deploy:party     # = partykit deploy --with-vars  (uploads RQ_REACTOR_API_KEY from .env)
# then set NEXT_PUBLIC_PARTYKIT_HOST to the deployed host and deploy the web app
```

Alternatively, store the secret in PartyKit once (prompts for the value) and
deploy without `--with-vars`:

```bash
npx partykit env add RQ_REACTOR_API_KEY
npx partykit deploy
```
