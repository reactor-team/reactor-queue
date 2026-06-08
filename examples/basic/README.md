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

The example uses the published `@reactor-team/js-sdk` (2.11.2+), which is where
`connectOptions.sessionId` — the API the queue attaches with — shipped. No local
link or override is needed.

From the **repo root** (build the workspace packages first):

```bash
pnpm install
pnpm --filter "./packages/*" build
```

Then:

```bash
cd examples/basic
cp .env.example .env
# edit .env: set RQ_REACTOR_API_KEY (and RQ_ADMIN_PASSWORD for /admin)
pnpm dev
```

- Next.js → http://localhost:3000 (demo) · http://localhost:3000/admin (dashboard)
- PartyKit → http://127.0.0.1:1999

The `.env` carries only two things: the browser's `NEXT_PUBLIC_PARTYKIT_HOST`
(read by Next.js) and the server secrets `RQ_REACTOR_API_KEY` / `RQ_ADMIN_PASSWORD`
(loaded automatically by `partykit dev` onto `room.env`). Everything about how
the queue behaves lives in `partykit/server.ts`.

Open http://localhost:3000. You'll see your queue position; click **Enter the
demo** when you reach the front. The example ships with `maxSessions: 1` (and
duplicate connections allowed), so just open a second tab to watch the line form
behind yourself.

## Where things are configured

- **`partykit/server.ts`** — the one place the queue is configured. The
  `createReactorQueueServer({ ... })` call sets the model, capacity, and timings,
  each typed and commented. This is the file to edit to change the demo's behavior.
- **`.env`** — secrets and the browser host only (`RQ_REACTOR_API_KEY`,
  `RQ_ADMIN_PASSWORD`, `NEXT_PUBLIC_PARTYKIT_HOST`). No queue tuning here.
- **`partykit.json`** — PartyKit plumbing (`name`, `main`, `compatibilityDate`).
  Nothing to tune.

## What to look at

- `app/page.tsx` — the entire client: `<ReactorQueueProvider>`, a phase switch,
  the gated `<ReactorProvider getJwt={queue.getJwt}>`, and `SessionBridge`.
- `app/admin/page.tsx` — live queue dashboard (kick members, force-close sessions).

## Deploy

`partykit deploy --with-vars` pushes the secrets from your local `.env`:

```bash
pnpm deploy:party     # = partykit deploy --with-vars  (uploads secrets from .env)
# then set NEXT_PUBLIC_PARTYKIT_HOST to the deployed host and deploy the web app
```

Alternatively, store the secret in PartyKit once (prompts for the value) and
deploy without `--with-vars`:

```bash
npx partykit env add RQ_REACTOR_API_KEY
npx partykit deploy
```
