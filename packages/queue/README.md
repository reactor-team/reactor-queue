# @reactor-team/queue

Drop-in waiting room for [Reactor](https://reactor.inc) demos — the whole thing
in one package. A PartyKit server lines users up, creates Reactor sessions, and
mints short-lived JWTs; a framework-agnostic + React client gates your app on the
queue and hands the SDK a `getJwt` resolver and a `sessionId`.

```bash
pnpm add @reactor-team/queue
```

Each surface is a subpath entry point, so you import only the half you need:

- **Client** — `import { ReactorQueueClient } from "@reactor-team/queue";`
- **React** — `import { ReactorQueueProvider, useReactorQueue } from "@reactor-team/queue/react";`
- **Server** (PartyKit) — `import { createReactorQueueServer } from "@reactor-team/queue/server";`
- **Admin** — `@reactor-team/queue/admin` and `@reactor-team/queue/admin/react`
- **Protocol** — `@reactor-team/queue/protocol` (shared wire types; rarely needed directly)

`react`/`zustand` (client) and `partykit` (server) are **optional peer
dependencies** — you only need the ones for the surfaces you import.

See the [repo README](https://github.com/reactor-team/reactor-queue) for the full
architecture, configuration, and deployment guide.
