import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restartLiveUpdates, startLiveUpdates, stopLiveUpdates } from "./liveUpdates";

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.OPEN;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  emitMessage() {
    this.onmessage?.();
  }

  emitFatalError() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

describe("liveUpdates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    stopLiveUpdates();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("invalidates live query keys on a tick and holds a single connection", () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    startLiveUpdates(queryClient);
    startLiveUpdates(queryClient);
    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.instances[0].emitMessage();
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["requests-page", "all"],
      ["sessions-page"],
      ["session"]
    ]);
  });

  it("reuses the active connection after a module reload", async () => {
    const queryClient = new QueryClient();

    startLiveUpdates(queryClient);
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.resetModules();
    const reloaded = await import("./liveUpdates");
    reloaded.startLiveUpdates(queryClient);

    expect(FakeEventSource.instances).toHaveLength(1);
    reloaded.stopLiveUpdates();
    expect(FakeEventSource.instances[0].readyState).toBe(FakeEventSource.CLOSED);
  });

  it("retries a fatal close while signed in and stops retrying once stopped", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["me"], { organizationId: "org_a" });

    startLiveUpdates(queryClient);
    FakeEventSource.instances[0].emitFatalError();
    expect(FakeEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(15_000);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.instances[1].emitFatalError();
    stopLiveUpdates();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("clears a pending retry when a new connection starts, so stop cancels everything", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["me"], { organizationId: "org_a" });

    startLiveUpdates(queryClient);
    FakeEventSource.instances[0].emitFatalError();
    startLiveUpdates(queryClient);
    expect(FakeEventSource.instances).toHaveLength(2);

    // A second failure overwrites the retry handle; if connect had not
    // cleared the first timer it would fire orphaned, past this stop.
    vi.advanceTimersByTime(5_000);
    FakeEventSource.instances[1].emitFatalError();
    stopLiveUpdates();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("does not retry when signed out and restart swaps the connection", () => {
    const queryClient = new QueryClient();

    startLiveUpdates(queryClient);
    FakeEventSource.instances[0].emitFatalError();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    restartLiveUpdates(queryClient);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0].readyState).toBe(FakeEventSource.CLOSED);
  });
});
