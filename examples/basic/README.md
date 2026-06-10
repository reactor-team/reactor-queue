# Basic example

The smallest end-to-end demo: one page (`app/page.tsx`) puts the
[Helios](https://docs.reactor.inc) text-to-video model behind the queue, as one
Next.js app plus one PartyKit room.

It walks through every queue phase — line position, the "you're up" admission
countdown, the live session with a time-left clock, expiry, and a rejoin prompt —
and shows the two integration points: `getJwt={queue.getJwt}` and
`connectOptions={{ sessionId: queue.sessionId, connectionId: queue.connectionId }}`,
so the SDK attaches to the server-created session and connection.

As soon as the session is ready, the page auto-sends one prompt (the glowing words
"REACTOR QUEUE") and starts generating, so you get live video right away. Adding a
queue leaves your model code untouched: swap `HeliosProvider` for any typed SDK (or
the base `Reactor`) and your existing controls work as-is.

## Run it

The example uses the published `@reactor-team/js-sdk` (2.12.0+), where
`connectOptions.connectionId` — the API the queue attaches with — shipped.

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

The `.env` carries two things: the browser's `NEXT_PUBLIC_PARTYKIT_HOST` (read by
Next.js) and the server secrets `RQ_REACTOR_API_KEY` / `RQ_ADMIN_PASSWORD` (loaded
by `partykit dev` onto `room.env`). How the queue behaves lives in
`partykit/server.ts`.

Open http://localhost:3000 and you'll see your queue position; click **Enter the
demo** when you reach the front. The example ships with `maxSessions: 1` and
duplicate connections allowed, so open a second tab to watch the line form behind
yourself.

## Where things are configured

- **`partykit/server.ts`** — the one place the queue is configured. The
  `createReactorQueueServer({ ... })` call sets the model, capacity, and timings,
  each typed and commented. Edit this to change the demo's behavior.
- **`.env`** — secrets and the browser host (`RQ_REACTOR_API_KEY`,
  `RQ_ADMIN_PASSWORD`, `NEXT_PUBLIC_PARTYKIT_HOST`).
- **`partykit.json`** — PartyKit plumbing (`name`, `main`, `compatibilityDate`).

## What to look at

- `app/page.tsx` — the entire client: `<ReactorQueueProvider>`, a phase switch,
  the gated `<ReactorProvider getJwt={queue.getJwt}>`, and `SessionBridge`.
- `app/admin/page.tsx` — live queue dashboard: stats, per-session controls (kick
  members, force-close sessions), and a streaming activity log (events and errors
  pushed live over the admin socket — e.g. a Coordinator quota rejection shows its
  HTTP status and body).

## Deploy

`partykit deploy --with-vars` pushes the secrets from your local `.env`:

```bash
pnpm deploy:party     # = partykit deploy --with-vars  (uploads secrets from .env)
# then set NEXT_PUBLIC_PARTYKIT_HOST to the deployed host and deploy the web app
```

Alternatively, store the secret in PartyKit once (prompts for the value) and deploy
without `--with-vars`:

```bash
npx partykit env add RQ_REACTOR_API_KEY
npx partykit deploy
```
