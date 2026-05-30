# @reactor-team/queue

Client for the [Reactor demo queue](https://github.com/reactor-team/reactor-queue).
A framework-agnostic WebSocket client plus a React/zustand layer that exposes a
`getJwt` resolver you drop straight into `@reactor-team/js-sdk`.

```bash
pnpm add @reactor-team/queue
```

- Core: `import { ReactorQueueClient } from "@reactor-team/queue";`
- React: `import { ReactorQueueProvider, useReactorQueue } from "@reactor-team/queue/react";`

See the [repo README](https://github.com/reactor-team/reactor-queue) for the full guide.
