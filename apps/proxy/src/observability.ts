import type { AppendEventInput, BoundedEventWriter, EventAppender } from "./events.js";

type Warn = (error: unknown, message: string) => void;

const asyncEventTypes = new Set([
  "prompt_cache.plan_applied",
  "routing.classification_recorded"
]);

export class AsyncObservabilityEventAppender implements EventAppender {
  constructor(
    private readonly events: EventAppender,
    private readonly writer: BoundedEventWriter
  ) {}

  async append(input: AppendEventInput) {
    if (!asyncEventTypes.has(input.eventType)) return this.events.append(input);
    this.writer.enqueue(input);
  }
}

export function scheduleObservability(
  warn: Warn,
  label: string,
  operation: () => Promise<void>
) {
  void Promise.resolve()
    .then(operation)
    .catch((error) => warn(error, `${label} failed`));
}
