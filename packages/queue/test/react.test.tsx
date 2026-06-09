import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("partysocket", () => import("./helpers/socket"));

import { act, render, screen } from "@testing-library/react";
import { ReactorQueueProvider, useReactorQueue } from "../src/react";
import type { QueueState } from "../src/types";
import type { QueueActions } from "../src/react";
import { lastSocket, resetSockets } from "./helpers/socket";

beforeEach(() => {
  resetSockets();
  localStorage.clear();
});

const renders: Array<QueueState & QueueActions> = [];

function Probe() {
  const q = useReactorQueue();
  renders.push(q);
  return <div data-testid="phase">{q.phase}</div>;
}

describe("ReactorQueueProvider", () => {
  it("throws when the hook is used outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used inside a <ReactorQueueProvider>/);
    spy.mockRestore();
  });

  it("auto-connects on mount and mirrors server messages into the hook", () => {
    renders.length = 0;
    render(
      <ReactorQueueProvider host="queue.test">
        <Probe />
      </ReactorQueueProvider>
    );
    expect(screen.getByTestId("phase").textContent).toBe("connecting");

    const socket = lastSocket();
    act(() => {
      socket.emitMessage({ type: "queue_position", position: 2, total: 4, active: 1, capacity: 1 });
    });
    expect(screen.getByTestId("phase").textContent).toBe("queued");
    expect(renders.at(-1)!.position).toBe(2);
  });

  it("exposes a stable getJwt reference across re-renders", () => {
    renders.length = 0;
    render(
      <ReactorQueueProvider host="queue.test">
        <Probe />
      </ReactorQueueProvider>
    );
    const socket = lastSocket();
    act(() => {
      socket.emitMessage({ type: "queue_position", position: 1, total: 1, active: 0, capacity: 1 });
    });
    expect(renders.length).toBeGreaterThan(1);
    const first = renders[0]!.getJwt;
    const latest = renders.at(-1)!.getJwt;
    expect(latest).toBe(first);
  });

  it("does not connect when autoConnect is false", () => {
    resetSockets();
    render(
      <ReactorQueueProvider host="queue.test" autoConnect={false}>
        <Probe />
      </ReactorQueueProvider>
    );
    expect(lastSocketCount()).toBe(0);
  });
});

function lastSocketCount(): number {
  try {
    lastSocket();
    return 1;
  } catch {
    return 0;
  }
}
