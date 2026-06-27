import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase } from "@proxy/db";
import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { EventService } from "../src/events.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { listen, startOpenAIMock } from "./helpers.js";
import {
  createMetricsCollector,
  type HistogramSample,
  InMemoryMetricsCollector,
  SafeMetricsCollector,
  type MetricSample,
  type MetricsCollector
} from "../src/metrics.js";

const productionSecrets = {
  PROXY_TOKEN: "prod-token",
  OPENAI_API_KEY: "prod-openai-key",
  ANTHROPIC_API_KEY: "prod-anthropic-key"
};

describe("metrics collector", () => {
  it("records counters, gauges, and histograms in memory", () => {
    const metrics = new InMemoryMetricsCollector({
      histogramBuckets: {
        proxy_http_request_duration_seconds: [0.1, 1]
      }
    });

    metrics.incrementCounter("proxy_http_requests_total", { method: "GET", route_family: "health" });
    metrics.incrementCounter("proxy_http_requests_total", { route_family: "health", method: "GET" }, 2);
    metrics.setGauge("proxy_model_requests_in_flight", 3, { stream: true, surface: "openai-responses" });
    metrics.observeHistogram("proxy_http_request_duration_seconds", 0.05, { route_family: "health" });
    metrics.observeHistogram("proxy_http_request_duration_seconds", 2, { route_family: "health" });

    expect(metrics.snapshot()).toEqual({
      counters: [{
        name: "proxy_http_requests_total",
        labels: { method: "GET", route_family: "health" },
        value: 3
      }],
      gauges: [{
        name: "proxy_model_requests_in_flight",
        labels: { stream: "true", surface: "openai-responses" },
        value: 3
      }],
      histograms: [{
        name: "proxy_http_request_duration_seconds",
        labels: { route_family: "health" },
        count: 2,
        sum: 2.05,
        buckets: [
          { le: 0.1, count: 1 },
          { le: 1, count: 1 },
          { le: "+Inf", count: 2 }
        ]
      }]
    });
  });

  it("renders deterministic OpenMetrics text", () => {
    const metrics = new InMemoryMetricsCollector({
      histogramBuckets: {
        proxy_classifier_duration_seconds: [0.5]
      }
    });

    metrics.incrementCounter("proxy_classifier_attempts_total", {
      error_class: "none",
      model: "gpt \"nano\"",
      provider: "openai"
    });
    metrics.observeHistogram("proxy_classifier_duration_seconds", 0.25, { provider: "openai" });

    expect(metrics.renderOpenMetrics()).toBe([
      "# TYPE proxy_classifier_attempts_total counter",
      "proxy_classifier_attempts_total{error_class=\"none\",model=\"gpt \\\"nano\\\"\",provider=\"openai\"} 1",
      "# TYPE proxy_classifier_duration_seconds histogram",
      "proxy_classifier_duration_seconds_bucket{provider=\"openai\",le=\"0.5\"} 1",
      "proxy_classifier_duration_seconds_bucket{provider=\"openai\",le=\"+Inf\"} 1",
      "proxy_classifier_duration_seconds_sum{provider=\"openai\"} 0.25",
      "proxy_classifier_duration_seconds_count{provider=\"openai\"} 1",
      "# EOF",
      ""
    ].join("\n"));
  });

  it("uses a noop collector when metrics are disabled", () => {
    const metrics = createMetricsCollector({ metricsEnabled: false, metricsExporter: "prometheus" });

    metrics.incrementCounter("proxy_http_requests_total");
    metrics.setGauge("proxy_up", 1);
    metrics.observeHistogram("proxy_http_request_duration_seconds", 0.1);

    expect(metrics.snapshot()).toEqual({ counters: [], gauges: [], histograms: [] });
    expect(metrics.renderOpenMetrics()).toBe("# EOF\n");
  });

  it("uses contract buckets for known histogram families", () => {
    const metrics = new InMemoryMetricsCollector();

    metrics.observeHistogram("proxy_provider_attempt_duration_seconds", 90);
    metrics.observeHistogram("proxy_db_query_duration_seconds", 0.002);

    const snapshot = metrics.snapshot();
    const provider = histogramByName(snapshot.histograms, "proxy_provider_attempt_duration_seconds");
    const db = histogramByName(snapshot.histograms, "proxy_db_query_duration_seconds");

    expect(provider?.buckets).toEqual(expect.arrayContaining([
      { le: 60, count: 0 },
      { le: 120, count: 1 },
      { le: 600, count: 1 }
    ]));
    expect(db?.buckets).toEqual(expect.arrayContaining([
      { le: 0.001, count: 0 },
      { le: 0.005, count: 1 }
    ]));
  });

  it("catches sink failures without throwing", () => {
    const metrics = new SafeMetricsCollector(new ThrowingMetricsCollector());

    expect(() => metrics.incrementCounter("proxy_http_requests_total")).not.toThrow();
    expect(() => metrics.setGauge("proxy_up", 1)).not.toThrow();
    expect(() => metrics.observeHistogram("proxy_http_request_duration_seconds", 0.1)).not.toThrow();

    expect(metrics.snapshot().counters).toEqual([{
      name: "proxy_metrics_sink_errors_total",
      labels: { error_class: "unknown" },
      value: 4
    }]);
  });
});

describe("metrics config", () => {
  it("loads disabled metrics defaults", () => {
    const config = loadConfig({});

    expect(config.metricsEnabled).toBe(false);
    expect(config.metricsExporter).toBe("none");
    expect(config.metricsPath).toBe("/metrics");
    expect(config.metricsAuthMode).toBe("token");
    expect(config.metricsToken).toBeUndefined();
  });

  it("loads enabled Prometheus metrics settings", () => {
    const config = loadConfig({
      METRICS_ENABLED: "true",
      METRICS_PATH: "/internal/metrics",
      METRICS_AUTH_MODE: "token",
      METRICS_TOKEN: "metrics-token"
    });

    expect(config.metricsEnabled).toBe(true);
    expect(config.metricsExporter).toBe("prometheus");
    expect(config.metricsPath).toBe("/internal/metrics");
    expect(config.metricsAuthMode).toBe("token");
    expect(config.metricsToken).toBe("metrics-token");
  });

  it("rejects unsafe production metrics auth", () => {
    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionSecrets,
      METRICS_ENABLED: "true",
      METRICS_AUTH_MODE: "none"
    })).toThrow("METRICS_AUTH_MODE=none cannot be used with METRICS_ENABLED in production.");

    expect(() => loadConfig({
      NODE_ENV: "production",
      ...productionSecrets,
      METRICS_ENABLED: "true",
      METRICS_EXPORTER: "prometheus",
      METRICS_AUTH_MODE: "token"
    })).toThrow("METRICS_TOKEN must be set before enabling token-authenticated metrics in production.");
  });

  it("rejects invalid metrics paths", () => {
    expect(() => loadConfig({ METRICS_PATH: "metrics" })).toThrow("METRICS_PATH must be an absolute path");
    expect(() => loadConfig({ METRICS_PATH: "/metrics?debug=true" })).toThrow("METRICS_PATH must be an absolute path");
  });
});

describe("server metrics", () => {
  it("records persistence disabled at startup", async () => {
    const metrics = new InMemoryMetricsCollector();
    const app = buildServer(loadConfig({ LOG_LEVEL: "fatal" }), { metrics });
    await app.close();

    expect(sampleValue(metrics.snapshot().gauges, "proxy_up", {})).toBe(1);
    expect(sampleValue(metrics.snapshot().gauges, "proxy_persistence_enabled", {})).toBe(0);
  });

  it("records HTTP route metrics", async () => {
    const metrics = new InMemoryMetricsCollector({
      histogramBuckets: {
        proxy_http_request_duration_seconds: [10]
      }
    });
    const app = buildServer(loadConfig({ LOG_LEVEL: "fatal" }), { metrics });

    const response = await app.inject({ method: "GET", url: "/healthz" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(sampleValue(metrics.snapshot().counters, "proxy_http_requests_total", {
      error_class: "none",
      method: "GET",
      route_family: "health",
      status_class: "2xx"
    })).toBe(1);
    expect(metrics.snapshot().histograms).toContainEqual(expect.objectContaining({
      name: "proxy_http_request_duration_seconds",
      labels: { method: "GET", route_family: "health", status_class: "2xx" },
      count: 1
    }));
  });

  it("records unauthenticated model requests as auth failures", async () => {
    const metrics = new InMemoryMetricsCollector({
      histogramBuckets: {
        proxy_model_request_duration_seconds: [10]
      }
    });
    const app = buildServer(loadConfig({ LOG_LEVEL: "fatal" }), { metrics });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      payload: { model: "router-fast", input: "hi" }
    });
    await app.close();
    const snapshot = metrics.snapshot();

    expect(response.statusCode).toBe(401);
    expect(sampleValue(snapshot.counters, "proxy_http_requests_total", {
      error_class: "auth",
      method: "POST",
      route_family: "openai",
      status_class: "4xx"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_model_requests_total", {
      error_class: "auth",
      stream: "unknown",
      surface: "openai-responses",
      terminal_status: "failed"
    })).toBe(1);
    expect(sampleValue(snapshot.gauges, "proxy_model_requests_in_flight", {
      stream: "unknown",
      surface: "openai-responses"
    })).toBe(0);
  });

  it("records malformed model requests as validation failures", async () => {
    const metrics = new InMemoryMetricsCollector();
    const app = buildServer(loadConfig({ LOG_LEVEL: "fatal" }), { metrics });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: "Bearer dev-token",
        "content-type": "application/json"
      },
      payload: "{"
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(sampleValue(metrics.snapshot().counters, "proxy_model_requests_total", {
      error_class: "validation",
      stream: "unknown",
      surface: "anthropic-messages",
      terminal_status: "failed"
    })).toBe(1);
  });
});

describe("metrics endpoint", () => {
  it("is disabled unless metrics are enabled", async () => {
    const app = buildServer(loadConfig({ LOG_LEVEL: "fatal" }));

    const response = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();

    expect(response.statusCode).toBe(404);
  });

  it("requires the configured metrics token", async () => {
    const metrics = new InMemoryMetricsCollector();
    metrics.setGauge("proxy_up", 1);
    const app = buildServer(loadConfig({
      LOG_LEVEL: "fatal",
      METRICS_ENABLED: "true",
      METRICS_TOKEN: "metrics-token"
    }), { metrics });

    const unauthorized = await app.inject({ method: "GET", url: "/metrics" });
    const authorized = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer metrics-token" }
    });
    await app.close();

    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.body).not.toContain("proxy_up");
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["content-type"]).toContain("application/openmetrics-text");
    expect(authorized.headers["cache-control"]).toBe("no-store");
    expect(authorized.body).toContain("# TYPE proxy_up gauge");
    expect(authorized.body).toContain("proxy_up 1");
  });

  it("does not allow token auth metrics without a token", async () => {
    const app = buildServer(loadConfig({
      LOG_LEVEL: "fatal",
      METRICS_ENABLED: "true"
    }));

    const response = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();

    expect(response.statusCode).toBe(401);
  });
});

describe("routing and provider metrics", () => {
  it("records classifier, routing, provider, stream, usage, and cost metrics", async () => {
    const openai = await startOpenAIMock({
      classifierUsage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12
      },
      outputText: "routed"
    });
    const metrics = new InMemoryMetricsCollector();
    const app = buildServer(loadConfig(proxyTestEnv(openai.url)), { metrics });

    try {
      const proxyUrl = await listen(app);
      const response = await fetch(`${proxyUrl}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer proxy-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: "router-auto",
          input: [{ role: "user", content: [{ type: "input_text", text: "debug a failing auth test" }] }],
          stream: true
        })
      });
      await response.text();
    } finally {
      await app.close();
      await openai.close();
    }

    const snapshot = metrics.snapshot();
    expect(sampleValue(snapshot.counters, "proxy_classifier_attempts_total", {
      error_class: "none",
      model: "route-classifier-cheap",
      outcome: "succeeded",
      provider: "openai"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_classifier_tokens_total", {
      model: "route-classifier-cheap",
      provider: "openai",
      usage_kind: "total"
    })).toBe(12);
    expect(sampleValue(snapshot.counters, "proxy_routing_decisions_total", {
      final_route: "hard",
      guardrail_action: "translated_request:openai-responses_to_anthropic-messages",
      model: "gpt-routed-hard-test",
      provider: "openai",
      requested_route: "hard",
      surface: "openai-responses"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_provider_attempts_total", {
      error_class: "none",
      model: "gpt-routed-hard-test",
      provider: "openai",
      status_class: "2xx",
      stream: "true",
      surface: "openai-responses",
      terminal_status: "succeeded"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_prompt_cache_plans_total", {
      mode: "implicit",
      model: "gpt-routed-hard-test",
      provider: "openai",
      surface: "openai-responses"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_prompt_cache_plan_controls_total", {
      control: "implicit_prefix_caching",
      mode: "implicit",
      model: "gpt-routed-hard-test",
      provider: "openai",
      reason: "none",
      status: "applied",
      surface: "openai-responses"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_usage_tokens_total", {
      model: "gpt-routed-hard-test",
      provider: "openai",
      surface: "openai-responses",
      usage_kind: "total"
    })).toBe(120);
    expect(sampleValue(snapshot.counters, "proxy_cost_usd_total", {
      cost_kind: "provider",
      model: "gpt-routed-hard-test",
      provider: "openai",
      surface: "openai-responses"
    })).toBeGreaterThan(0);
    expect(sampleValue(snapshot.counters, "proxy_provider_stream_bytes_total", {
      model: "gpt-routed-hard-test",
      provider: "openai",
      surface: "openai-responses",
      terminal_status: "succeeded"
    })).toBeGreaterThan(0);
    expect(sampleValue(snapshot.gauges, "proxy_terminal_pending_provider_attempts", {
      provider: "openai",
      surface: "openai-responses"
    })).toBe(0);
    expect(sampleValue(snapshot.gauges, "proxy_model_requests_in_flight", {
      stream: "true",
      surface: "openai-responses"
    })).toBe(0);
  });

  it("records streamed provider failures after bytes with failed model lifecycle metrics", async () => {
    const openai = await startOpenAIMock({ failStreamAfterChunk: true });
    const metrics = new InMemoryMetricsCollector();
    const app = buildServer(loadConfig(proxyTestEnv(openai.url)), { metrics });

    try {
      const proxyUrl = await listen(app);
      try {
        const response = await fetch(`${proxyUrl}/v1/responses`, {
          method: "POST",
          headers: {
            authorization: "Bearer proxy-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model: "router-auto",
            input: [{ role: "user", content: [{ type: "input_text", text: "debug a flaky stream" }] }],
            stream: true
          })
        });
        await response.text();
      } catch {
      }
    } finally {
      await app.close();
      await openai.close();
    }

    const snapshot = metrics.snapshot();
    expect(sampleValue(snapshot.counters, "proxy_provider_attempts_total", {
      error_class: "provider",
      model: "gpt-routed-hard-test",
      provider: "openai",
      status_class: "2xx",
      stream: "true",
      surface: "openai-responses",
      terminal_status: "failed"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_provider_stream_bytes_total", {
      model: "gpt-routed-hard-test",
      provider: "openai",
      surface: "openai-responses",
      terminal_status: "failed"
    })).toBeGreaterThan(0);
    expect(sampleValue(snapshot.counters, "proxy_model_requests_total", {
      error_class: "provider",
      stream: "true",
      surface: "openai-responses",
      terminal_status: "failed"
    })).toBe(1);
  });
});

describe("event and outbox metrics", () => {
  it("records event appends and successful outbox processing", async () => {
    const metrics = new InMemoryMetricsCollector();
    const events = new EventService(undefined, undefined, undefined, "local", metrics);

    await events.append({
      scopeType: "request",
      scopeId: "request-1",
      producer: "test",
      eventType: "test.event"
    });
    await events.processOutbox(async () => {});

    const snapshot = metrics.snapshot();
    expect(sampleValue(snapshot.counters, "proxy_event_appends_total", {
      error_class: "none",
      outcome: "succeeded"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_event_outbox_items_total", {
      error_class: "none",
      outcome: "queued"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_event_outbox_items_total", {
      error_class: "none",
      outcome: "processing"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_event_outbox_items_total", {
      error_class: "none",
      outcome: "succeeded"
    })).toBe(1);
    expect(sampleValue(snapshot.gauges, "proxy_outbox_backlog", {})).toBe(0);
    expect(sampleValue(snapshot.gauges, "proxy_outbox_oldest_item_age_seconds", {})).toBe(0);
  });

  it("records failed event appends and failed outbox processing", async () => {
    const metrics = new InMemoryMetricsCollector();
    const failedAppendEvents = new EventService(undefined, undefined, {
      append: async () => {
        throw new Error("db down");
      }
    }, "local", metrics);
    const failedOutboxEvents = new EventService(undefined, undefined, undefined, "local", metrics);

    await expect(failedAppendEvents.append({
      scopeType: "request",
      scopeId: "request-1",
      producer: "test",
      eventType: "test.event"
    })).rejects.toThrow("db down");
    await failedOutboxEvents.append({
      scopeType: "request",
      scopeId: "request-2",
      producer: "test",
      eventType: "test.event"
    });
    await failedOutboxEvents.processOutbox(async () => {
      throw new Error("fanout failed");
    });

    const snapshot = metrics.snapshot();
    expect(sampleValue(snapshot.counters, "proxy_event_appends_total", {
      error_class: "persistence",
      outcome: "failed"
    })).toBe(1);
    expect(sampleValue(snapshot.counters, "proxy_event_outbox_items_total", {
      error_class: "unknown",
      outcome: "failed"
    })).toBe(1);
  });

  it("records durable outbox health from the database sink", async () => {
    const client = await migratedClient();
    try {
      const db = createPgliteDatabase(client);
      const metrics = new InMemoryMetricsCollector();
      const config = loadConfig({ DATABASE_URL: "", EVENT_STORE_PATH: "", LOG_LEVEL: "fatal" });
      const persistence = createDatabasePersistence(db, config, false, metrics);
      const events = new EventService(undefined, undefined, persistence.eventSink, "local", metrics);

      await events.append({
        tenantId: "org_metrics",
        scopeType: "request",
        scopeId: "request-1",
        producer: "test",
        eventType: "test.event"
      });

      const snapshot = metrics.snapshot();
      expect(sampleValue(snapshot.gauges, "proxy_outbox_backlog", {})).toBe(1);
      expect(sampleValue(snapshot.gauges, "proxy_outbox_oldest_item_age_seconds", {})).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close();
    }
  });
});

class ThrowingMetricsCollector implements MetricsCollector {
  incrementCounter() {
    throw new Error("counter failed");
  }
  setGauge() {
    throw new Error("gauge failed");
  }
  observeHistogram() {
    throw new Error("histogram failed");
  }
  snapshot() {
    throw new Error("snapshot failed");
  }
  renderOpenMetrics() {
    throw new Error("render failed");
  }
}

function sampleValue(samples: MetricSample[], name: string, labels: Record<string, string>) {
  return samples.find((sample) => (
    sample.name === name && sameLabels(sample.labels, labels)
  ))?.value;
}

function histogramByName(samples: HistogramSample[], name: string) {
  return samples.find((sample) => sample.name === name);
}

function sameLabels(left: Record<string, string>, right: Record<string, string>) {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([key, value]) => right[key] === value);
}

function proxyTestEnv(openaiUrl: string) {
  return {
    DATABASE_URL: "",
    EVENT_STORE_PATH: "",
    PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    OPENAI_BASE_URL: openaiUrl,
    OPENAI_HARD_MODEL: "gpt-routed-hard-test",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    ANTHROPIC_BASE_URL: openaiUrl,
    CLASSIFIER_PROVIDER: "openai",
    CLASSIFIER_MODEL: "route-classifier-cheap",
    MODEL_COSTS_JSON: JSON.stringify({
      "openai:route-classifier-cheap": {
        inputCostPerMtok: 1,
        outputCostPerMtok: 2
      },
      "openai:gpt-routed-hard-test": {
        inputCostPerMtok: 3,
        outputCostPerMtok: 6
      }
    }),
    LOG_LEVEL: "fatal"
  };
}

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  }
  return client;
}
