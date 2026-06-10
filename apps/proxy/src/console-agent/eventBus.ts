import type { ConsoleAgentEmittedEvent } from "./runtime.js";

type Listener = (event: ConsoleAgentEmittedEvent) => void;

export class ConsoleAgentEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(event: ConsoleAgentEmittedEvent) {
    for (const listener of this.listeners.get(event.runId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not affect the run or other subscribers.
      }
    }
  }

  subscribe(runId: string, listener: Listener) {
    const existing = this.listeners.get(runId) ?? new Set<Listener>();
    existing.add(listener);
    this.listeners.set(runId, existing);
    return () => {
      existing.delete(listener);
      if (existing.size === 0) this.listeners.delete(runId);
    };
  }
}
