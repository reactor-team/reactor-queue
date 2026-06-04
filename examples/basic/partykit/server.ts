import { createReactorQueueServer } from "@reactor-team/queue-server";

// The whole queue. Operational config comes from partykit.json `vars` and the
// RQ_REACTOR_API_KEY secret, so this stays a one-liner.
//
// Those partykit.json `vars` are tuned for a frictionless demo, not for
// production: low caps (RQ_MAX_SESSIONS=2), and RQ_ALLOW_DUPLICATE_CONNECTIONS
// is "true" so the same browser can open several tabs. For a real deployment,
// drop the duplicate-connection allowance, set RQ_ALLOWED_ORIGINS to your
// site(s), and size the caps to your model's actual capacity.
export default createReactorQueueServer();
