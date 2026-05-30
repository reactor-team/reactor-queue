import { createReactorQueueServer } from "@reactor-team/queue-server";

// The whole queue. Operational config comes from partykit.json `vars` and the
// RQ_REACTOR_API_KEY secret, so this stays a one-liner.
export default createReactorQueueServer();
