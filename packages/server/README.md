# @reactor-team/queue-server

PartyKit server for the [Reactor demo queue](https://github.com/reactor-team/reactor-queue):
FIFO admission gating, short-lived Reactor JWT minting, per-user session timers,
and session reaping.

```bash
pnpm add @reactor-team/queue-server partykit
```

```ts
// partykit/server.ts
import { createReactorQueueServer } from "@reactor-team/queue-server";
export default createReactorQueueServer({ model: "helios", maxSessions: 3 });
```

Set the `RQ_REACTOR_API_KEY` secret. See the
[repo README](https://github.com/reactor-team/reactor-queue) for config and deploy.
