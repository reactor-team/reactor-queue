"use client";

import { CSSProperties, useEffect, useRef, useState } from "react";
import { ReactorQueueProvider, useReactorQueue } from "@reactor-team/queue/react";
import { useReactor } from "@reactor-team/js-sdk";
import {
  HeliosProvider,
  HeliosMainVideoView,
  useHelios,
  useHeliosConditionsReady,
} from "@reactor-models/helios";

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST;

// Sent automatically once the session is ready so there's video on screen with
// zero model-control UI. Helios is text-to-video — a prompt + start is all it needs.
const PROMPT =
  'A cinematic 3D render of the glowing words "REACTOR QUEUE" forged in polished ' +
  "chrome, floating in a dark studio void, volumetric god-rays and drifting embers, " +
  "a slow dolly push-in, shallow depth of field, dramatic rim lighting.";

// ── The whole example ───────────────────────────────────────────────────────
//
// One page. <ReactorQueueProvider> owns the waiting-room connection; <Gate>
// switches on the queue phase; only when the user is `active` do we mount a
// real Reactor session — getting `getJwt` straight from the queue and reporting
// the SDK's session id back so the server can time-box and stop it.
export default function Page() {
  if (!PARTYKIT_HOST) {
    return (
      <Center>
        <Card>
          <h1 style={s.h1}>Setup</h1>
          <p style={s.muted}>
            Copy <code>.env.example</code> → <code>.env</code>, set{" "}
            <code>RQ_REACTOR_API_KEY</code>, then run <code>pnpm dev</code>.
          </p>
        </Card>
      </Center>
    );
  }
  return (
    <ReactorQueueProvider host={PARTYKIT_HOST}>
      <Gate />
    </ReactorQueueProvider>
  );
}

function Gate() {
  const q = useReactorQueue();
  // `idle` and "left after a session" are the same state in the SDK; the app
  // decides whether to show a rejoin prompt. We track that locally.
  const [exited, setExited] = useState(false);
  const leave = () => {
    q.leave();
    setExited(true);
  };
  const rejoin = () => {
    setExited(false);
    q.rejoin();
  };

  if (exited) {
    return (
      <Center>
        <Card>
          <h1 style={s.h1}>You left the demo</h1>
          <p style={s.muted}>Your slot was released for the next person.</p>
          <Button onClick={rejoin}>Rejoin the queue</Button>
        </Card>
      </Center>
    );
  }

  switch (q.phase) {
    case "queued":
      return (
        <Center>
          <Card>
            <Label>You're in line</Label>
            <div style={s.bigNum}>#{q.position}</div>
            <p style={s.muted}>
              of {q.total} waiting · {q.active}/{q.maxConcurrent} live now
            </p>
            <Button variant="ghost" onClick={leave}>
              Leave queue
            </Button>
          </Card>
        </Center>
      );

    case "admitted":
      return (
        <Center>
          <Card>
            <Label>You're up!</Label>
            <p style={s.muted}>Enter before the timer runs out.</p>
            <Countdown to={q.sessionEndsAt} caption="to enter" />
            <Button onClick={q.claim}>Enter the demo</Button>
          </Card>
        </Center>
      );

    case "active":
      return <Session onLeave={leave} />;

    case "expired":
      return (
        <Center>
          <Card>
            <h1 style={s.h1}>Your time's up</h1>
            <p style={s.muted}>Thanks for trying it out.</p>
            <Button onClick={rejoin}>Rejoin the queue</Button>
          </Card>
        </Center>
      );

    case "rejected":
      return (
        <Center>
          <Card>
            <h1 style={s.h1}>Already open elsewhere</h1>
            <p style={s.muted}>
              This browser has the demo open in another tab. Close it; this page
              reconnects automatically.
            </p>
          </Card>
        </Center>
      );

    default: // idle / connecting / disconnected
      return (
        <Center>
          <Card>
            <Spinner />
            <p style={{ ...s.muted, marginTop: 16 }}>Connecting to the queue…</p>
          </Card>
        </Center>
      );
  }
}

// ── The gated session ─────────────────────────────────────────────────────
function Session({ onLeave }: { onLeave: () => void }) {
  const { getJwt, sessionEndsAt } = useReactorQueue();
  return (
    // getJwt is referentially stable — pass it directly, don't wrap in an arrow.
    // autoConnect is fine here because the user already opted in via "Enter".
    <HeliosProvider getJwt={getJwt} connectOptions={{ autoConnect: true }}>
      <SessionBridge />
      <AutoPrompt />
      <div style={s.stage}>
        <header style={s.bar}>
          <StatusDot />
          <span style={{ flex: 1 }} />
          {sessionEndsAt && <Countdown to={sessionEndsAt} inline caption="left" />}
          <Button variant="ghost" onClick={onLeave}>
            Leave
          </Button>
        </header>
        <HeliosMainVideoView style={s.video} videoObjectFit="contain" />
      </div>
    </HeliosProvider>
  );
}

// As soon as Helios is ready, send one prompt and start generating — no control
// UI. The ref guards against re-sending; it resets if the session drops so a
// reconnect re-primes the scene.
//
// `set_prompt` is processed into conditioning asynchronously and emits
// `conditions_ready` when the model can actually generate; calling `start()`
// before that is a no-op (the race that left generation un-started). So we park
// the conditions_ready resolver BEFORE sending the prompt — registering after
// would race the model's reply — then await it before `start()`.
function AutoPrompt() {
  const { status, setPrompt, start } = useHelios();
  const sent = useRef(false);
  const conditionsReady = useRef<(() => void) | null>(null);

  useHeliosConditionsReady(() => {
    conditionsReady.current?.();
    conditionsReady.current = null;
  });

  useEffect(() => {
    if (status !== "ready") {
      sent.current = false;
      return;
    }
    if (sent.current) return;
    sent.current = true;
    void (async () => {
      const ready = new Promise<void>((resolve) => {
        conditionsReady.current = resolve;
        // Fallback so a missed event never hangs generation forever.
        setTimeout(resolve, 10_000);
      });
      await setPrompt({ prompt: PROMPT });
      await ready;
      await start();
    })();
  }, [status, setPrompt, start]);

  return null;
}

// The only glue between the two packages: report the SDK session id to the
// queue (so the server can time-box / stop it) and free the slot on exit.
function SessionBridge() {
  const { reportSession, endSession } = useReactorQueue();
  const sessionId = useReactor((st) => st.sessionId);
  useEffect(() => {
    if (sessionId) reportSession(sessionId);
  }, [sessionId, reportSession]);
  useEffect(() => () => endSession(), [endSession]);
  return null;
}

function StatusDot() {
  const status = useReactor((st) => st.status);
  const color = status === "ready" ? "#4ade80" : status === "disconnected" ? "#71717a" : "#fbbf24";
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
      <span style={{ fontSize: 13, color: "#a1a1aa" }}>{status}</span>
    </span>
  );
}

// ── UI primitives ───────────────────────────────────────────────────────────
function Countdown({
  to,
  caption,
  inline,
}: {
  to: number | null;
  caption: string;
  inline?: boolean;
}) {
  const left = useCountdown(to);
  if (left === null) return null;
  const m = Math.floor(left / 60);
  const sec = String(left % 60).padStart(2, "0");
  const label = `${m}:${sec}`;
  const warn = left <= 10;
  if (inline) {
    return (
      <span style={{ ...s.clockInline, color: warn ? "#f87171" : "#d4d4d8" }}>
        {label} {caption}
      </span>
    );
  }
  return (
    <>
      <div style={{ ...s.clock, color: warn ? "#f87171" : "#d9b15e" }}>{label}</div>
      <div style={s.clockCaption}>{caption}</div>
    </>
  );
}

function useCountdown(to: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (to === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [to]);
  if (to === null) return null;
  return Math.max(0, Math.round((to - now) / 1000));
}

function Center({ children }: { children: React.ReactNode }) {
  return <main style={s.center}>{children}</main>;
}

function Card({ children }: { children: React.ReactNode }) {
  return <div style={s.card}>{children}</div>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={s.label}>{children}</div>;
}

function Button({
  children,
  onClick,
  variant = "primary",
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "primary" | "ghost";
}) {
  return (
    <button onClick={onClick} style={variant === "primary" ? s.btnPrimary : s.btnGhost}>
      {children}
    </button>
  );
}

function Spinner() {
  return <span style={s.spinner} />;
}

// ── styles ────────────────────────────────────────────────────────────────
const s: Record<string, CSSProperties> = {
  center: { minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 },
  card: {
    width: "100%",
    maxWidth: 360,
    textAlign: "center",
    border: "1px solid #27272a",
    background: "rgba(24,24,27,0.4)",
    borderRadius: 16,
    padding: 32,
  },
  h1: { fontSize: 18, fontWeight: 600, margin: "0 0 4px" },
  muted: { fontSize: 14, color: "#a1a1aa", marginTop: 4, lineHeight: 1.5 },
  label: { fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "#71717a" },
  bigNum: { fontSize: 48, fontWeight: 600, color: "#d9b15e", margin: "8px 0 0" },
  clock: { fontFamily: "ui-monospace, monospace", fontSize: 40, margin: "16px 0 0" },
  clockCaption: {
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: "#71717a",
    marginTop: 4,
  },
  clockInline: { fontFamily: "ui-monospace, monospace", fontSize: 13 },
  btnPrimary: {
    marginTop: 20,
    border: "none",
    borderRadius: 8,
    background: "#d9b15e",
    color: "#0b1020",
    fontWeight: 600,
    fontSize: 14,
    padding: "10px 20px",
  },
  btnGhost: {
    marginTop: 16,
    border: "1px solid #3f3f46",
    borderRadius: 8,
    background: "transparent",
    color: "#d4d4d8",
    fontSize: 13,
    padding: "6px 14px",
  },
  spinner: {
    display: "inline-block",
    width: 24,
    height: 24,
    border: "2px solid #3f3f46",
    borderTopColor: "#d9b15e",
    borderRadius: 999,
    animation: "spin 0.8s linear infinite",
  },
  stage: { minHeight: "100vh", display: "flex", flexDirection: "column" },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 20px",
    borderBottom: "1px solid #27272a",
    background: "rgba(24,24,27,0.4)",
  },
  video: { flex: 1, width: "100%", background: "#000" },
};
