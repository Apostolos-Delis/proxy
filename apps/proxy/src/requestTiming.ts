import { performance } from "node:perf_hooks";

import type { Provider, RouteDecision, Surface } from "./types.js";

type TimingLogger = {
  info: (payload: unknown, message: string) => void;
};

type TimingOptions = {
  nowMs?: () => number;
  scheduleImmediate?: (callback: () => void) => void;
};

export type RequestTimingMetadata = {
  requestId?: string;
  organizationId?: string;
  workspaceId?: string;
  surface: Surface;
  provider?: Provider;
  logicalModel?: string;
  selectedModel?: string;
  requestBodyBytes?: number;
};

export type RequestTimingStatus = "completed" | "failed" | "cancelled" | "rejected" | "duplicate";

export class RequestTiming {
  private readonly startedAtMs: number;
  private readonly phases: Record<string, number> = {};
  private readonly milestones: Record<string, number> = {};
  private readonly nowMs: () => number;
  private readonly scheduleImmediate: (callback: () => void) => void;
  private eventLoopLagScheduledAtMs: number | undefined;
  private eventLoopLagMs: number | undefined;
  private logged = false;

  constructor(
    private readonly logger: TimingLogger,
    private metadata: RequestTimingMetadata,
    options: TimingOptions = {}
  ) {
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.scheduleImmediate = options.scheduleImmediate ?? ((callback) => setImmediate(callback));
    this.startedAtMs = this.nowMs();
  }

  addMetadata(metadata: Partial<RequestTimingMetadata>) {
    this.metadata = { ...this.metadata, ...metadata };
  }

  async measure<T>(phase: string, operation: () => T | Promise<T>): Promise<T> {
    const startedAt = this.nowMs();
    try {
      return await operation();
    } finally {
      this.addPhase(phase, this.nowMs() - startedAt);
    }
  }

  measureSync<T>(phase: string, operation: () => T): T {
    const startedAt = this.nowMs();
    try {
      return operation();
    } finally {
      this.addPhase(phase, this.nowMs() - startedAt);
    }
  }

  sampleEventLoopLag() {
    const scheduledAt = this.nowMs();
    this.eventLoopLagScheduledAtMs = scheduledAt;
    this.scheduleImmediate(() => {
      this.eventLoopLagMs = roundMs(Math.max(0, this.nowMs() - scheduledAt));
    });
  }

  recordEventLoopLag(ms: number) {
    this.eventLoopLagMs = roundMs(Math.max(0, ms));
  }

  recordDecision(decision: RouteDecision) {
    this.addMetadata({
      provider: decision.provider,
      logicalModel: decision.requestedModel,
      selectedModel: decision.selectedModel
    });
  }

  markProviderFetchStart() {
    this.mark("providerFetchStartMs");
  }

  markFirstByte() {
    if (this.milestones.firstByteMs === undefined) this.mark("firstByteMs");
  }

  markStreamCompletion() {
    this.mark("streamCompletionMs");
  }

  log(status: RequestTimingStatus, extra: Record<string, unknown> = {}) {
    if (this.logged) return;
    this.logged = true;
    const eventLoopLagMs = this.currentEventLoopLagMs();
    this.logger.info({
      requestPathLatency: {
        ...this.metadata,
        ...extra,
        status,
        totalMs: roundMs(this.nowMs() - this.startedAtMs),
        eventLoopLagMs,
        phases: roundedRecord(this.phases),
        milestones: roundedRecord(this.milestones)
      }
    }, "request path latency");
  }

  private addPhase(phase: string, durationMs: number) {
    this.phases[phase] = (this.phases[phase] ?? 0) + Math.max(0, durationMs);
  }

  private mark(name: string) {
    this.milestones[name] = Math.max(0, this.nowMs() - this.startedAtMs);
  }

  private currentEventLoopLagMs() {
    if (this.eventLoopLagMs !== undefined) return this.eventLoopLagMs;
    if (this.eventLoopLagScheduledAtMs === undefined) return undefined;
    return roundMs(Math.max(0, this.nowMs() - this.eventLoopLagScheduledAtMs));
  }
}

export function requestBodySizeBytes(contentLength: string | undefined, body: unknown) {
  const parsedLength = contentLength ? Number.parseInt(contentLength, 10) : Number.NaN;
  if (Number.isFinite(parsedLength) && parsedLength >= 0) return parsedLength;
  if (body === undefined) return 0;
  return approximateJsonBytes(body, new WeakSet<object>());
}

function roundedRecord(record: Record<string, number>) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, roundMs(value)]));
}

function roundMs(value: number) {
  return Math.round(value * 100) / 100;
}

function approximateJsonBytes(value: unknown, seen: WeakSet<object>): number | undefined {
  if (value === null) return 4;
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return 0;
  if (typeof value === "string") return Buffer.byteLength(value) + 2;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return Buffer.byteLength(String(value));
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    let total = 2;
    for (let index = 0; index < value.length; index += 1) {
      const child = approximateJsonBytes(value[index], seen);
      if (child === undefined) return undefined;
      total += child + (index > 0 ? 1 : 0);
    }
    seen.delete(value);
    return total;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return undefined;
    seen.add(value);
    let total = 2;
    let index = 0;
    for (const [key, childValue] of Object.entries(value)) {
      const child = approximateJsonBytes(childValue, seen);
      if (child === undefined) return undefined;
      total += Buffer.byteLength(key) + 3 + child + (index > 0 ? 1 : 0);
      index += 1;
    }
    seen.delete(value);
    return total;
  }
  return undefined;
}
