export type MetricLabelValue = string | number | boolean | null | undefined;
export type MetricLabels = Record<string, MetricLabelValue>;
export type MetricKind = "counter" | "gauge" | "histogram";

export type MetricSample = {
  name: string;
  labels: Record<string, string>;
  value: number;
};

export type HistogramSample = {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  buckets: { le: number | "+Inf"; count: number }[];
};

export type MetricsSnapshot = {
  counters: MetricSample[];
  gauges: MetricSample[];
  histograms: HistogramSample[];
};

export type MetricsCollector = {
  incrementCounter(name: string, labels?: MetricLabels, value?: number): void;
  setGauge(name: string, value: number, labels?: MetricLabels): void;
  observeHistogram(name: string, value: number, labels?: MetricLabels): void;
  snapshot(): MetricsSnapshot;
  renderOpenMetrics(): string;
};

export type MetricsCollectorConfig = {
  metricsEnabled: boolean;
  metricsExporter: "none" | "prometheus";
};

export type MetricsCollectorOptions = {
  defaultHistogramBuckets?: number[];
  histogramBuckets?: Record<string, number[]>;
};

type StoredSample = {
  name: string;
  labels: Record<string, string>;
  value: number;
};

type StoredHistogram = {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  buckets: { le: number; count: number }[];
};

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const MODEL_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];
const TIME_TO_FIRST_BYTE_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
const CLASSIFIER_DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const DB_DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const DEFAULT_HISTOGRAM_BUCKETS_BY_METRIC: Record<string, number[]> = {
  proxy_http_request_duration_seconds: HTTP_DURATION_BUCKETS,
  proxy_model_request_duration_seconds: MODEL_DURATION_BUCKETS,
  proxy_provider_attempt_duration_seconds: MODEL_DURATION_BUCKETS,
  proxy_provider_time_to_first_byte_seconds: TIME_TO_FIRST_BYTE_BUCKETS,
  proxy_classifier_duration_seconds: CLASSIFIER_DURATION_BUCKETS,
  proxy_db_query_duration_seconds: DB_DURATION_BUCKETS
};

export class NoopMetricsCollector implements MetricsCollector {
  incrementCounter() {}
  setGauge() {}
  observeHistogram() {}
  snapshot() {
    return emptySnapshot();
  }
  renderOpenMetrics() {
    return "# EOF\n";
  }
}

export class InMemoryMetricsCollector implements MetricsCollector {
  private readonly defaultHistogramBuckets: number[];
  private readonly histogramBuckets: Record<string, number[]>;
  private readonly counters = new Map<string, StoredSample>();
  private readonly gauges = new Map<string, StoredSample>();
  private readonly histograms = new Map<string, StoredHistogram>();

  constructor(options: MetricsCollectorOptions = {}) {
    this.defaultHistogramBuckets = normalizeBuckets(options.defaultHistogramBuckets ?? HTTP_DURATION_BUCKETS);
    this.histogramBuckets = Object.fromEntries(
      Object.entries({
        ...DEFAULT_HISTOGRAM_BUCKETS_BY_METRIC,
        ...options.histogramBuckets
      }).map(([name, buckets]) => [name, normalizeBuckets(buckets)])
    );
  }

  incrementCounter(name: string, labels: MetricLabels = {}, value = 1) {
    if (!Number.isFinite(value) || value < 0) return;

    const sample = this.sample(this.counters, name, labels);
    sample.value += value;
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}) {
    if (!Number.isFinite(value)) return;

    const sample = this.sample(this.gauges, name, labels);
    sample.value = value;
  }

  observeHistogram(name: string, value: number, labels: MetricLabels = {}) {
    if (!Number.isFinite(value)) return;

    const normalizedLabels = normalizeLabels(labels);
    const key = sampleKey(name, normalizedLabels);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      const buckets = (this.histogramBuckets[name] ?? this.defaultHistogramBuckets)
        .map((le) => ({ le, count: 0 }));
      histogram = { name, labels: normalizedLabels, count: 0, sum: 0, buckets };
      this.histograms.set(key, histogram);
    }

    histogram.count += 1;
    histogram.sum += value;
    for (const bucket of histogram.buckets) {
      if (value <= bucket.le) bucket.count += 1;
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: sortedSamples(this.counters),
      gauges: sortedSamples(this.gauges),
      histograms: [...this.histograms.values()]
        .map((histogram) => ({
          name: histogram.name,
          labels: { ...histogram.labels },
          count: histogram.count,
          sum: histogram.sum,
          buckets: [
            ...histogram.buckets.map((bucket) => ({ le: bucket.le, count: bucket.count })),
            { le: "+Inf" as const, count: histogram.count }
          ]
        }))
        .sort(compareSamples)
    };
  }

  renderOpenMetrics() {
    return renderOpenMetrics(this.snapshot());
  }

  private sample(store: Map<string, StoredSample>, name: string, labels: MetricLabels) {
    const normalizedLabels = normalizeLabels(labels);
    const key = sampleKey(name, normalizedLabels);
    const sample = store.get(key);
    if (sample) return sample;

    const next = { name, labels: normalizedLabels, value: 0 };
    store.set(key, next);
    return next;
  }
}

export class OpenMetricsCollector extends InMemoryMetricsCollector {}

export class SafeMetricsCollector implements MetricsCollector {
  private readonly sinkErrors = new InMemoryMetricsCollector();

  constructor(private readonly delegate: MetricsCollector) {}

  incrementCounter(name: string, labels?: MetricLabels, value?: number) {
    this.record(() => this.delegate.incrementCounter(name, labels, value));
  }

  setGauge(name: string, value: number, labels?: MetricLabels) {
    this.record(() => this.delegate.setGauge(name, value, labels));
  }

  observeHistogram(name: string, value: number, labels?: MetricLabels) {
    this.record(() => this.delegate.observeHistogram(name, value, labels));
  }

  snapshot() {
    try {
      return mergeSnapshots(this.delegate.snapshot(), this.sinkErrors.snapshot());
    } catch {
      this.recordSinkError();
      return this.sinkErrors.snapshot();
    }
  }

  renderOpenMetrics() {
    try {
      return renderOpenMetrics(this.snapshot());
    } catch {
      this.recordSinkError();
      return this.sinkErrors.renderOpenMetrics();
    }
  }

  private record(recording: () => void) {
    try {
      recording();
    } catch {
      this.recordSinkError();
    }
  }

  private recordSinkError() {
    this.sinkErrors.incrementCounter("proxy_metrics_sink_errors_total", { error_class: "unknown" });
  }
}

export function createMetricsCollector(config: MetricsCollectorConfig): MetricsCollector {
  if (!config.metricsEnabled || config.metricsExporter === "none") return new NoopMetricsCollector();
  return new SafeMetricsCollector(new OpenMetricsCollector());
}

export function metricStatusClassFor(statusCode: number) {
  if (statusCode >= 100 && statusCode < 600) return `${Math.floor(statusCode / 100)}xx`;
  return "unknown";
}

export function metricErrorClassForStatus(statusCode: number) {
  if (statusCode < 400) return "none";
  if (statusCode === 401 || statusCode === 403) return "auth";
  if (statusCode === 408 || statusCode === 504) return "timeout";
  if (statusCode === 499) return "client_cancelled";
  if (statusCode === 400 || statusCode === 404 || statusCode === 405 || statusCode === 415 || statusCode === 422) return "validation";
  if (statusCode === 409) return "routing";
  if (statusCode >= 500) return "unknown";
  return "unknown";
}

export function metricTerminalStatusFor(status: "completed" | "failed" | "cancelled") {
  if (status === "completed") return "succeeded";
  return status;
}

function normalizeLabels(labels: MetricLabels) {
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([key]) => key.length > 0)
      .map(([key, value]) => [key, normalizeLabelValue(value)])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function normalizeLabelValue(value: MetricLabelValue) {
  if (value === null || value === undefined || value === "") return "unknown";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function sampleKey(name: string, labels: Record<string, string>) {
  return `${name}\0${JSON.stringify(labels)}`;
}

function sortedSamples(samples: Map<string, StoredSample>) {
  return [...samples.values()]
    .map((sample) => ({ name: sample.name, labels: { ...sample.labels }, value: sample.value }))
    .sort(compareSamples);
}

function compareSamples(left: { name: string; labels: Record<string, string> }, right: { name: string; labels: Record<string, string> }) {
  const nameOrder = left.name.localeCompare(right.name);
  if (nameOrder !== 0) return nameOrder;
  return JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels));
}

function normalizeBuckets(buckets: number[]) {
  return [...new Set(buckets.filter((bucket) => Number.isFinite(bucket) && bucket >= 0).sort((left, right) => left - right))];
}

function renderOpenMetrics(snapshot: MetricsSnapshot) {
  const lines: string[] = [];
  const emitted = new Set<string>();

  for (const sample of snapshot.counters) {
    emitType(lines, emitted, sample.name, "counter");
    lines.push(`${sample.name}${renderLabels(sample.labels)} ${sample.value}`);
  }

  for (const sample of snapshot.gauges) {
    emitType(lines, emitted, sample.name, "gauge");
    lines.push(`${sample.name}${renderLabels(sample.labels)} ${sample.value}`);
  }

  for (const histogram of snapshot.histograms) {
    emitType(lines, emitted, histogram.name, "histogram");
    for (const bucket of histogram.buckets) {
      lines.push(`${histogram.name}_bucket${renderLabels({ ...histogram.labels, le: String(bucket.le) })} ${bucket.count}`);
    }
    lines.push(`${histogram.name}_sum${renderLabels(histogram.labels)} ${histogram.sum}`);
    lines.push(`${histogram.name}_count${renderLabels(histogram.labels)} ${histogram.count}`);
  }

  lines.push("# EOF");
  return `${lines.join("\n")}\n`;
}

function emitType(lines: string[], emitted: Set<string>, name: string, kind: MetricKind) {
  if (emitted.has(name)) return;
  emitted.add(name);
  lines.push(`# TYPE ${name} ${kind}`);
}

function renderLabels(labels: Record<string, string>) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function escapeLabelValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}

function mergeSnapshots(left: MetricsSnapshot, right: MetricsSnapshot): MetricsSnapshot {
  return {
    counters: [...left.counters, ...right.counters].sort(compareSamples),
    gauges: [...left.gauges, ...right.gauges].sort(compareSamples),
    histograms: [...left.histograms, ...right.histograms].sort(compareSamples)
  };
}

function emptySnapshot(): MetricsSnapshot {
  return {
    counters: [],
    gauges: [],
    histograms: []
  };
}
