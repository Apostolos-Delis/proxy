import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase } from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";

import { loadConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { buildServer } from "../src/server.js";

type SurfaceName = "openai" | "anthropic";
type ClassifierMode = "hit" | "miss";
type ProviderMode = "ok" | "429" | "5xx" | "timeout";
type TargetMode = "local" | "external";

type Scenario = {
  name: string;
  surface: SurfaceName;
  concurrency: number;
  totalRequests: number;
  rps: number | null;
  bodyBytes: number;
  classifierMode: ClassifierMode;
  providerMode: ProviderMode;
  requestTimeoutMs: number;
  streamChunks: number;
  streamChunkDelayMs: number;
};

type RequestResult = {
  id: string;
  status: number | null;
  ok: boolean;
  error?: string;
  ttftMs: number | null;
  preForwardMs: number | null;
  streamDurationMs: number | null;
  totalMs: number;
  responseBytes: number;
};

type ScenarioResult = {
  name: string;
  scenario: Scenario;
  requests: number;
  successes: number;
  failures: number;
  errorRate: number;
  ttftMs: Percentiles | null;
  preForwardMs: Percentiles | null;
  streamDurationMs: Percentiles | null;
  totalMs: Percentiles;
  responseBytes: Percentiles;
  classifierCalls?: number;
  providerCalls?: number;
  dbPoolWaitMs: null;
  memory: MemorySummary;
  thresholdFailures: string[];
};

type Percentiles = {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

type MemorySummary = {
  startRssBytes: number;
  peakRssBytes: number;
  endRssBytes: number;
  startHeapUsedBytes: number;
  peakHeapUsedBytes: number;
  endHeapUsedBytes: number;
};

type LoadResult = {
  startedAt: string;
  target: TargetMode;
  baseUrl: string;
  profile: string;
  thresholds: Thresholds;
  passed: boolean;
  scenarios: ScenarioResult[];
};

type Thresholds = {
  maxErrorRate: number | null;
  maxP95TtftMs: number | null;
  maxP95PreForwardMs: number | null;
  maxP99TotalMs: number | null;
};

type MockRecord = {
  requestId: string;
  model: string | undefined;
  receivedAtMs: number;
  provider: "openai" | "anthropic";
};

type MockState = {
  scenario: Scenario;
  records: MockRecord[];
};

type Runtime = {
  baseUrl: string;
  apiKey: string;
  target: TargetMode;
  mockState?: MockState;
  close: () => Promise<void>;
};

const args = parseArgs(process.argv.slice(2));
const profile = option("profile", "PROMPT_PROXY_LOAD_PROFILE", "smoke");
const jsonOnly = booleanOption("json", "PROMPT_PROXY_LOAD_JSON", false);
const jsonOut = option("json-out", "PROMPT_PROXY_LOAD_JSON_OUT", "");
const scenarios = scenariosFor(profile);
const thresholds = thresholdsFor(profile);
const startedAt = new Date().toISOString();
const runtime = await createRuntime(scenarios);

try {
  const scenarioResults: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    if (!jsonOnly) {
      console.log(`load_scenario_start name=${scenario.name} concurrency=${scenario.concurrency} requests=${scenario.totalRequests} rps=${scenario.rps ?? "unlimited"} bodyBytes=${scenario.bodyBytes} classifier=${scenario.classifierMode} provider=${scenario.providerMode}`);
    }
    if (runtime.mockState) runtime.mockState.scenario = scenario;
    scenarioResults.push(await runScenario(runtime, scenario, thresholds));
  }

  const result: LoadResult = {
    startedAt,
    target: runtime.target,
    baseUrl: runtime.baseUrl,
    profile,
    thresholds,
    passed: scenarioResults.every((scenario) => scenario.thresholdFailures.length === 0),
    scenarios: scenarioResults
  };

  if (jsonOut) await writeJsonOutput(jsonOut, result);
  if (jsonOnly) {
    console.log(JSON.stringify(result));
  } else {
    printSummary(result);
    if (jsonOut) console.log(`load_json=${jsonOut}`);
  }
  if (!result.passed) process.exitCode = 1;
} finally {
  await runtime.close();
}

async function runScenario(runtime: Runtime, scenario: Scenario, activeThresholds: Thresholds): Promise<ScenarioResult> {
  if (scenario.classifierMode === "hit") {
    const warmup = await runOne(runtime, scenario, -1, true);
    if (scenario.providerMode === "ok" && !warmup.ok) {
      throw new Error(`Classifier hit warmup failed for ${scenario.name}: status=${warmup.status} error=${warmup.error ?? "unknown"}`);
    }
  }

  const beforeRecordCount = runtime.mockState?.records.length ?? 0;
  const memory = startMemorySampler();
  const startedAtMs = performance.now();
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(scenario.concurrency, scenario.totalRequests) }, async () => {
    const results: RequestResult[] = [];
    while (nextIndex < scenario.totalRequests) {
      const index = nextIndex;
      nextIndex += 1;
      if (scenario.rps) {
        const scheduledAt = startedAtMs + (index * 1000 / scenario.rps);
        const delayMs = scheduledAt - performance.now();
        if (delayMs > 0) await sleep(delayMs);
      }
      results.push(await runOne(runtime, scenario, index, false));
    }
    return results;
  });
  const results = (await Promise.all(workers)).flat();
  const memorySummary = memory.stop();
  const records = runtime.mockState?.records.slice(beforeRecordCount) ?? [];
  const providerCalls = records.filter((record) => record.model !== "route-classifier-cheap").length;
  const classifierCalls = records.filter((record) => record.model === "route-classifier-cheap").length;
  const successes = results.filter((result) => result.ok).length;
  const failures = results.length - successes;
  const summary: ScenarioResult = {
    name: scenario.name,
    scenario,
    requests: results.length,
    successes,
    failures,
    errorRate: round(failures / Math.max(1, results.length)),
    ttftMs: percentiles(results.flatMap((result) => result.ttftMs === null ? [] : [result.ttftMs])),
    preForwardMs: percentiles(results.flatMap((result) => result.preForwardMs === null ? [] : [result.preForwardMs])),
    streamDurationMs: percentiles(results.flatMap((result) => result.streamDurationMs === null ? [] : [result.streamDurationMs])),
    totalMs: percentiles(results.map((result) => result.totalMs)) ?? emptyPercentiles(),
    responseBytes: percentiles(results.map((result) => result.responseBytes)) ?? emptyPercentiles(),
    classifierCalls: runtime.mockState ? classifierCalls : undefined,
    providerCalls: runtime.mockState ? providerCalls : undefined,
    dbPoolWaitMs: null,
    memory: memorySummary,
    thresholdFailures: []
  };
  summary.thresholdFailures = thresholdFailures(summary, activeThresholds);
  return summary;
}

async function runOne(
  runtime: Runtime,
  scenario: Scenario,
  index: number,
  warmup: boolean
): Promise<RequestResult> {
  const requestId = `${scenario.name}-${warmup ? "warmup" : index}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = scenario.classifierMode === "hit"
    ? `${scenario.name}-shared-session`
    : `${scenario.name}-session-${index}`;
  const body = bodyForScenario(scenario, scenario.classifierMode === "miss" ? requestId : "shared");
  const startedAtMs = performance.now();

  try {
    const response = await fetch(requestUrl(runtime.baseUrl, scenario.surface), {
      method: "POST",
      headers: requestHeaders(runtime.apiKey, scenario.surface, sessionId, requestId),
      body,
      signal: AbortSignal.timeout(scenario.requestTimeoutMs)
    });
    const reader = response.body?.getReader();
    let firstByteAtMs: number | undefined;
    let responseBytes = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength > 0 && firstByteAtMs === undefined) firstByteAtMs = performance.now();
        responseBytes += chunk.value.byteLength;
      }
    } else {
      const text = await response.text();
      if (text.length > 0) firstByteAtMs = performance.now();
      responseBytes = Buffer.byteLength(text);
    }
    const completedAtMs = performance.now();
    const upstreamReceivedAtMs = runtime.mockState?.records.find((record) =>
      record.requestId === requestId && record.model !== "route-classifier-cheap"
    )?.receivedAtMs;
    return {
      id: requestId,
      status: response.status,
      ok: response.ok,
      ttftMs: firstByteAtMs === undefined ? null : round(firstByteAtMs - startedAtMs),
      preForwardMs: upstreamReceivedAtMs === undefined ? null : round(upstreamReceivedAtMs - startedAtMs),
      streamDurationMs: firstByteAtMs === undefined ? null : round(completedAtMs - firstByteAtMs),
      totalMs: round(completedAtMs - startedAtMs),
      responseBytes
    };
  } catch (error) {
    const completedAtMs = performance.now();
    const upstreamReceivedAtMs = runtime.mockState?.records.find((record) =>
      record.requestId === requestId && record.model !== "route-classifier-cheap"
    )?.receivedAtMs;
    return {
      id: requestId,
      status: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ttftMs: null,
      preForwardMs: upstreamReceivedAtMs === undefined ? null : round(upstreamReceivedAtMs - startedAtMs),
      streamDurationMs: null,
      totalMs: round(completedAtMs - startedAtMs),
      responseBytes: 0
    };
  }
}

function scenariosFor(profileName: string): Scenario[] {
  if (profileName === "custom") return [customScenario("custom")];
  if (hasCustomScenarioArgs()) return [customScenario("custom")];
  if (profileName === "concurrency") {
    return [200, 500, 1000].map((concurrency) => ({
      ...defaultScenario(`sse-${concurrency}`),
      concurrency,
      totalRequests: concurrency,
      bodyBytes: 100 * 1024,
      classifierMode: "hit",
      streamChunks: Math.max(numberOption("stream-chunks", "PROMPT_PROXY_LOAD_STREAM_CHUNKS", 2), 20),
      streamChunkDelayMs: Math.max(numberOption("stream-chunk-delay-ms", "PROMPT_PROXY_LOAD_STREAM_CHUNK_DELAY_MS", 5), 100)
    }));
  }
  if (profileName === "body-sizes") {
    return [
      ["body-100kb", 100 * 1024],
      ["body-1mb", 1024 * 1024],
      ["body-5mb", 5 * 1024 * 1024]
    ].map(([name, bodyBytes]) => ({
      ...defaultScenario(String(name)),
      concurrency: 20,
      totalRequests: 60,
      rps: 20,
      bodyBytes: Number(bodyBytes)
    }));
  }
  if (profileName === "rps") {
    return [20, 50, 100].map((rps) => ({
      ...defaultScenario(`rps-${rps}`),
      concurrency: rps,
      totalRequests: rps * 10,
      rps,
      bodyBytes: 100 * 1024
    }));
  }
  if (profileName === "classifier-cache") {
    return (["miss", "hit"] as ClassifierMode[]).map((classifierMode) => ({
      ...defaultScenario(`classifier-${classifierMode}`),
      concurrency: 20,
      totalRequests: 60,
      rps: 20,
      classifierMode
    }));
  }
  if (profileName === "provider-failures") {
    return (["429", "5xx", "timeout"] as ProviderMode[]).map((providerMode) => ({
      ...defaultScenario(`provider-${providerMode}`),
      concurrency: 5,
      totalRequests: 10,
      rps: 5,
      providerMode,
      requestTimeoutMs: providerMode === "timeout" ? 1500 : 10000
    }));
  }
  if (profileName === "scale-readiness") {
    return [
      ...scenariosFor("concurrency"),
      ...scenariosFor("body-sizes"),
      ...scenariosFor("rps"),
      ...scenariosFor("classifier-cache")
    ];
  }
  return [defaultScenario("smoke")];
}

function defaultScenario(name: string): Scenario {
  return {
    name,
    surface: surfaceOption(),
    concurrency: 2,
    totalRequests: 4,
    rps: 2,
    bodyBytes: 10 * 1024,
    classifierMode: "miss",
    providerMode: "ok",
    requestTimeoutMs: numberOption("request-timeout-ms", "PROMPT_PROXY_LOAD_REQUEST_TIMEOUT_MS", 30000),
    streamChunks: numberOption("stream-chunks", "PROMPT_PROXY_LOAD_STREAM_CHUNKS", 2),
    streamChunkDelayMs: numberOption("stream-chunk-delay-ms", "PROMPT_PROXY_LOAD_STREAM_CHUNK_DELAY_MS", 5)
  };
}

function customScenario(name: string): Scenario {
  const scenario = defaultScenario(name);
  return {
    ...scenario,
    concurrency: numberOption("concurrency", "PROMPT_PROXY_LOAD_CONCURRENCY", scenario.concurrency),
    totalRequests: numberOption("requests", "PROMPT_PROXY_LOAD_REQUESTS", scenario.totalRequests),
    rps: nullableNumberOption("rps", "PROMPT_PROXY_LOAD_RPS", scenario.rps),
    bodyBytes: numberOption("body-bytes", "PROMPT_PROXY_LOAD_BODY_BYTES", scenario.bodyBytes),
    classifierMode: classifierModeOption(),
    providerMode: providerModeOption()
  };
}

function requestUrl(baseUrl: string, surface: SurfaceName) {
  return surface === "openai" ? `${baseUrl}/v1/responses` : `${baseUrl}/v1/messages`;
}

function requestHeaders(apiKey: string, surface: SurfaceName, sessionId: string, requestId: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "x-request-id": requestId
  };
  if (surface === "openai") {
    headers["x-codex-session-id"] = sessionId;
  } else {
    headers["anthropic-version"] = "2023-06-01";
    headers["x-claude-code-session-id"] = sessionId;
  }
  return headers;
}

function bodyForScenario(scenario: Scenario, variant: string) {
  const payload = payloadText(scenario.bodyBytes, variant);
  if (scenario.surface === "openai") {
    return JSON.stringify({
      model: "coding-auto",
      input: payload,
      stream: true,
      max_output_tokens: 16
    });
  }
  return JSON.stringify({
    model: "coding-auto",
    messages: [{ role: "user", content: payload }],
    stream: true,
    max_tokens: 16
  });
}

function payloadText(bodyBytes: number, variant: string) {
  const prefix = `load variant ${variant}\n`;
  return `${prefix}${"x".repeat(Math.max(1, bodyBytes - 256 - prefix.length))}`;
}

async function createRuntime(activeScenarios: Scenario[]): Promise<Runtime> {
  const baseUrl = option("base-url", "PROMPT_PROXY_LOAD_BASE_URL", "");
  const apiKey = option("api-key", "PROMPT_PROXY_LOAD_API_KEY", process.env.PROMPT_PROXY_TOKEN ?? "proxy-token");
  if (baseUrl) {
    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey,
      target: "external",
      close: async () => {}
    };
  }

  const initialScenario = activeScenarios[0] ?? defaultScenario("smoke");
  const mockState: MockState = { scenario: initialScenario, records: [] };
  const openai = await mockProvider("openai", mockState);
  const anthropic = await mockProvider("anthropic", mockState);
  let persistence: Awaited<ReturnType<typeof createLoadPersistence>> | undefined;
  try {
    const env = {
      ...process.env,
      DATABASE_URL: "",
      EVENT_STORE_PATH: "",
      PROXY_TOKEN: apiKey,
      PROMPT_PROXY_TOKEN: apiKey,
      OPENAI_API_KEY: "openai-upstream-key",
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_API_KEY: "anthropic-upstream-key",
      ANTHROPIC_BASE_URL: anthropic.url,
      GATEWAY_SEED_CLASSIFIER_MODEL: "route-classifier-cheap",
      ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.1/32",
      ADMIN_DEV_LOGIN_ENABLED: "true",
      ADMIN_DEV_LOGIN_EMAIL: "local@example.com",
      ADMIN_DEV_LOGIN_PASSWORD: "dev-password",
      SEED_USER_ID: "local-user",
      LOG_LEVEL: option("proxy-log-level", "PROMPT_PROXY_LOAD_PROXY_LOG_LEVEL", "fatal")
    };
    const config = loadConfig(env);
    persistence = await createLoadPersistence(config, env);
    const activePersistence = persistence;
    const app = buildServer(config, { persistence: persistence.persistence });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey,
      target: "local",
      mockState,
      close: async () => {
        const closeApp = app.close();
        app.server.closeAllConnections?.();
        await closeApp;
        await activePersistence.close();
        await openai.close();
        await anthropic.close();
      }
    };
  } catch (error) {
    await persistence?.close();
    await openai.close();
    await anthropic.close();
    throw error;
  }
}

async function createLoadPersistence(config: ReturnType<typeof loadConfig>, env: NodeJS.ProcessEnv) {
  const client = new PGlite();
  const migrationsDir = join(process.cwd(), "../../packages/db/migrations");
  const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  }
  const db = createPgliteDatabase(client);
  await seedDatabase(db, seedOptionsFromEnv(env));
  return {
    persistence: createDatabasePersistence(db, config, false),
    close: () => client.close()
  };
}

async function mockProvider(provider: "openai" | "anthropic", state: MockState) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    const model = stringValue(body.model);
    const requestId = request.headers["x-request-id"];
    state.records.push({
      requestId: Array.isArray(requestId) ? requestId[0] ?? "" : requestId ?? "",
      model,
      receivedAtMs: performance.now(),
      provider
    });

    if (provider === "openai" && model === "route-classifier-cheap") {
      const targetId = firstClassifierTarget(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        output_text: JSON.stringify({
          target_id: targetId,
          reason_codes: ["load_test"],
          confidence: 0.9
        })
      }));
      return;
    }

    if (state.scenario.providerMode === "429") {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "load mock rate limited" } }));
      return;
    }
    if (state.scenario.providerMode === "5xx") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "load mock unavailable" } }));
      return;
    }
    if (state.scenario.providerMode === "timeout") {
      await sleep(state.scenario.requestTimeoutMs + 250);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    for (let index = 0; index < state.scenario.streamChunks; index += 1) {
      if (provider === "openai") {
        response.write(`data: ${JSON.stringify({
          type: index === state.scenario.streamChunks - 1 ? "response.completed" : "response.output_text.delta",
          delta: index === state.scenario.streamChunks - 1 ? undefined : "ok",
          response: { id: "resp_load", usage: { input_tokens: 10, output_tokens: 2 } }
        })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify(index === state.scenario.streamChunks - 1
          ? { type: "message_stop" }
          : { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } })}\n\n`);
      }
      if (state.scenario.streamChunkDelayMs > 0) await sleep(state.scenario.streamChunkDelayMs);
    }
    response.end();
  });
  return listen(server);
}

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
        })
      });
    });
  });
}

function readJson(request: IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => resolve(body ? parseRecord(body) : {}));
  });
}

function parseRecord(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function firstClassifierTarget(body: Record<string, unknown>) {
  const input = parseRecord(stringValue(body.input) ?? "");
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const first = targets[0];
  const targetId = first && typeof first === "object" && !Array.isArray(first)
    ? stringValue((first as Record<string, unknown>).id)
    : undefined;
  if (!targetId) throw new Error(`classifier request has no candidates: ${JSON.stringify(body)}`);
  return targetId;
}

function thresholdFailures(result: ScenarioResult, activeThresholds: Thresholds) {
  const failures: string[] = [];
  if (activeThresholds.maxErrorRate !== null && result.errorRate > activeThresholds.maxErrorRate) {
    failures.push(`errorRate ${result.errorRate} > ${activeThresholds.maxErrorRate}`);
  }
  if (activeThresholds.maxP95TtftMs !== null && result.ttftMs && result.ttftMs.p95 > activeThresholds.maxP95TtftMs) {
    failures.push(`ttft.p95 ${result.ttftMs.p95}ms > ${activeThresholds.maxP95TtftMs}ms`);
  }
  if (activeThresholds.maxP95PreForwardMs !== null && result.preForwardMs && result.preForwardMs.p95 > activeThresholds.maxP95PreForwardMs) {
    failures.push(`preForward.p95 ${result.preForwardMs.p95}ms > ${activeThresholds.maxP95PreForwardMs}ms`);
  }
  if (activeThresholds.maxP99TotalMs !== null && result.totalMs.p99 > activeThresholds.maxP99TotalMs) {
    failures.push(`total.p99 ${result.totalMs.p99}ms > ${activeThresholds.maxP99TotalMs}ms`);
  }
  return failures;
}

function thresholdsFor(profileName: string): Thresholds {
  const providerFailures = profileName === "provider-failures";
  return {
    maxErrorRate: nullableNumberOption("max-error-rate", "PROMPT_PROXY_LOAD_MAX_ERROR_RATE", providerFailures ? 1 : 0),
    maxP95TtftMs: nullableNumberOption("max-p95-ttft-ms", "PROMPT_PROXY_LOAD_MAX_P95_TTFT_MS", null),
    maxP95PreForwardMs: nullableNumberOption("max-p95-pre-forward-ms", "PROMPT_PROXY_LOAD_MAX_P95_PRE_FORWARD_MS", null),
    maxP99TotalMs: nullableNumberOption("max-p99-total-ms", "PROMPT_PROXY_LOAD_MAX_P99_TOTAL_MS", null)
  };
}

function printSummary(result: LoadResult) {
  console.log(`load_target=${result.target} baseUrl=${result.baseUrl} profile=${result.profile} passed=${result.passed}`);
  for (const scenario of result.scenarios) {
    console.log([
      `load_scenario=${scenario.name}`,
      `requests=${scenario.requests}`,
      `successes=${scenario.successes}`,
      `failures=${scenario.failures}`,
      `errorRate=${scenario.errorRate}`,
      `ttft_p95_ms=${scenario.ttftMs?.p95 ?? "n/a"}`,
      `pre_forward_p95_ms=${scenario.preForwardMs?.p95 ?? "n/a"}`,
      `stream_p95_ms=${scenario.streamDurationMs?.p95 ?? "n/a"}`,
      `total_p99_ms=${scenario.totalMs.p99}`,
      `rss_peak_mb=${round(scenario.memory.peakRssBytes / 1024 / 1024)}`,
      `classifierCalls=${scenario.classifierCalls ?? "n/a"}`,
      `providerCalls=${scenario.providerCalls ?? "n/a"}`
    ].join(" "));
    for (const failure of scenario.thresholdFailures) {
      console.log(`load_threshold_failure scenario=${scenario.name} ${failure}`);
    }
  }
}

async function writeJsonOutput(path: string, result: LoadResult) {
  const outputPath = isAbsolute(path)
    ? path
    : resolve(process.env.INIT_CWD ?? process.cwd(), path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: round(sorted[0] ?? 0),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: round(sorted[sorted.length - 1] ?? 0)
  };
}

function percentile(sorted: number[], quantile: number) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return round(sorted[index] ?? 0);
}

function emptyPercentiles(): Percentiles {
  return { min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
}

function startMemorySampler() {
  const start = process.memoryUsage();
  let peakRssBytes = start.rss;
  let peakHeapUsedBytes = start.heapUsed;
  const timer = setInterval(() => {
    const current = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, current.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, current.heapUsed);
  }, 100);
  return {
    stop: (): MemorySummary => {
      clearInterval(timer);
      const end = process.memoryUsage();
      return {
        startRssBytes: start.rss,
        peakRssBytes: Math.max(peakRssBytes, end.rss),
        endRssBytes: end.rss,
        startHeapUsedBytes: start.heapUsed,
        peakHeapUsedBytes: Math.max(peakHeapUsedBytes, end.heapUsed),
        endHeapUsedBytes: end.heapUsed
      };
    }
  };
}

function parseArgs(rawArgs: string[]) {
  const parsed = new Map<string, string | boolean>();
  for (let index = 0; index < rawArgs.length; index += 1) {
    const raw = rawArgs[index];
    if (!raw.startsWith("--")) continue;
    const body = raw.slice(2);
    if (!body) continue;
    const equalsIndex = body.indexOf("=");
    if (equalsIndex >= 0) {
      parsed.set(body.slice(0, equalsIndex), body.slice(equalsIndex + 1));
      continue;
    }
    const next = rawArgs[index + 1];
    if (next && !next.startsWith("--")) {
      parsed.set(body, next);
      index += 1;
    } else {
      parsed.set(body, true);
    }
  }
  return parsed;
}

function option(name: string, envName: string, fallback: string) {
  const argValue = args.get(name);
  if (typeof argValue === "string") return argValue;
  return process.env[envName] ?? fallback;
}

function booleanOption(name: string, envName: string, fallback: boolean) {
  const argValue = args.get(name);
  if (typeof argValue === "boolean") return argValue;
  if (typeof argValue === "string") return argValue !== "false" && argValue !== "0";
  const envValue = process.env[envName];
  if (envValue === undefined) return fallback;
  return envValue !== "false" && envValue !== "0";
}

function numberOption(name: string, envName: string, fallback: number) {
  const value = nullableNumberOption(name, envName, fallback);
  return value ?? fallback;
}

function nullableNumberOption(name: string, envName: string, fallback: number | null) {
  const raw = option(name, envName, fallback === null ? "" : String(fallback));
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric option ${name}: ${raw}`);
  }
  return parsed;
}

function surfaceOption(): SurfaceName {
  const surface = option("surface", "PROMPT_PROXY_LOAD_SURFACE", "openai");
  if (surface === "openai" || surface === "anthropic") return surface;
  throw new Error(`Invalid surface: ${surface}`);
}

function classifierModeOption(): ClassifierMode {
  const mode = option("classifier-mode", "PROMPT_PROXY_LOAD_CLASSIFIER_MODE", "miss");
  if (mode === "hit" || mode === "miss") return mode;
  throw new Error(`Invalid classifier mode: ${mode}`);
}

function providerModeOption(): ProviderMode {
  const mode = option("provider-mode", "PROMPT_PROXY_LOAD_PROVIDER_MODE", "ok");
  if (mode === "ok" || mode === "429" || mode === "5xx" || mode === "timeout") return mode;
  throw new Error(`Invalid provider mode: ${mode}`);
}

function hasCustomScenarioArgs() {
  return [
    "concurrency",
    "requests",
    "rps",
    "body-bytes",
    "classifier-mode",
    "provider-mode"
  ].some((name) => args.has(name));
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
