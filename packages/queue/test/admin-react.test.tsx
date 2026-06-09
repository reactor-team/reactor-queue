import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("partysocket", () => import("./helpers/socket"));

import { act, render, screen } from "@testing-library/react";
import { ReactorQueueAdminProvider, useReactorQueueAdmin } from "../src/admin-react";
import { lastSocket, resetSockets } from "./helpers/socket";

beforeEach(() => {
  resetSockets();
});

function Probe() {
  const a = useReactorQueueAdmin();
  return (
    <div>
      <span data-testid="phase">{a.phase}</span>
      <span data-testid="active">{a.snapshot?.activeCount ?? "—"}</span>
    </div>
  );
}

describe("ReactorQueueAdminProvider", () => {
  it("throws when the hook is used outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used inside a <ReactorQueueAdminProvider>/);
    spy.mockRestore();
  });

  it("connects, authenticates, and mirrors snapshots into the hook", async () => {
    render(
      <ReactorQueueAdminProvider host="queue.test" password="secret">
        <Probe />
      </ReactorQueueAdminProvider>
    );
    const socket = lastSocket();

    await act(async () => {
      socket.emitOpen();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(socket.sentMessages()[0]).toEqual({ type: "admin_auth", password: "secret" });

    act(() => {
      socket.emitMessage({ type: "admin_ready" });
      socket.emitMessage({
        type: "admin_snapshot",
        at: Date.now(),
        activeCount: 3,
        sessionCount: 1,
        config: {},
        queue: [],
        sessions: [],
        members: [],
      });
    });
    expect(screen.getByTestId("phase").textContent).toBe("ready");
    expect(screen.getByTestId("active").textContent).toBe("3");
  });
});
