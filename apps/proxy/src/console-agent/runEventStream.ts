import type { ConsoleAgentStore } from "../persistence/consoleAgentStore.js";
import type { ConsoleAgentEventBus } from "./eventBus.js";
import { terminalEventFor } from "./eventMapper.js";
import type { ConsoleAgentEmittedEvent } from "./runtime.js";

export type RunEventSink = {
  write(event: { seq?: number; type: string; payload: Record<string, unknown> }): Promise<void> | void;
  close(): void;
};

export type RunEventStreamHandle = {
  stop(): void;
};

// Replay-then-live delivery for one run's event ledger. Subscribes to the bus
// before reading the ledger so nothing falls between replay and live, dedupes
// by seq, and synthesizes a terminal event from the authoritative run status
// when the ledger lacks one (finalize crash window).
export async function streamRunEvents(
  deps: { store: ConsoleAgentStore; bus: ConsoleAgentEventBus },
  input: { organizationId: string; runId: string; lastEventId?: number },
  sink: RunEventSink
): Promise<RunEventStreamHandle> {
  let deliveredThrough = input.lastEventId ?? 0;
  let replaying = true;
  let closed = false;
  const buffered: ConsoleAgentEmittedEvent[] = [];
  let delivery: Promise<void> = Promise.resolve();

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    sink.close();
  };

  const deliver = (event: { seq?: number; type: string; payload: Record<string, unknown> }) => {
    delivery = delivery.then(async () => {
      if (closed) return;
      if (event.seq !== undefined) {
        if (event.seq <= deliveredThrough) return;
        deliveredThrough = event.seq;
      }
      try {
        await sink.write(event);
      } catch {
        close();
        return;
      }
      if (event.type === "run_finished" || event.type === "run_failed") close();
    });
    return delivery;
  };

  const unsubscribe = deps.bus.subscribe(input.runId, (event) => {
    if (replaying) {
      buffered.push(event);
      return;
    }
    void deliver(event);
  });

  try {
    const replayRows = await deps.store.listRunEvents(
      input.organizationId,
      input.runId,
      input.lastEventId
    );
    for (const row of replayRows) {
      await deliver({ seq: row.seq, type: row.type, payload: row.payload });
    }

    replaying = false;
    for (const event of buffered) {
      await deliver(event);
    }
    buffered.length = 0;

    if (!closed) {
      const run = await deps.store.getRun(input.organizationId, input.runId);
      if (run && run.status !== "running") {
        await deliver({ ...terminalEventFor(run.status, run.error), seq: undefined });
        close();
      }
    }
  } catch (error) {
    close();
    throw error;
  }

  return { stop: close };
}
