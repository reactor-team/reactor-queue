import { createReactorQueueServer } from "@reactor-team/queue/server";

// The whole queue server — and the one place its behavior is configured.
//
// Everything about how the line behaves is set right here, typed and documented
// on ReactorQueueServerConfig. The only thing that is NOT here is the Reactor
// API key: it's a secret, read from RQ_REACTOR_API_KEY in `.env` (and from a
// PartyKit secret in production). See `.env.example`.
//
// These values are tuned for a frictionless local demo, not production. For a
// real deployment, drop `allowDuplicateConnections`, set `allowedOrigins` to
// your site(s), and size `maxSessions` to the model's actual GPU capacity.
// Every option below also has an RQ_* env-var twin that overrides it — handy
// for retuning a deploy without editing code (see the repo README).
export default createReactorQueueServer({
  model: "helios", // model the queue opens sessions for (POST /sessions)
  maxSessions: 1, // concurrent GPU sessions — open a 2nd tab to see the line form
  usersPerSession: 1, // members per session (Helios is single-player)
  sessionDurationMs: 120_000, // each turn lasts 2 min, then the slot frees
  admissionGraceMs: 45_000, // time to click "Enter" once you're up
  allowDuplicateConnections: true, // demo-only: queue with yourself from one browser
});
