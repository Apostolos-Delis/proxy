/**
 * Demo stack for eyeballing the Caching console page with realistic data.
 * Boots the real proxy against an in-memory PGlite DB, drives traffic through
 * the actual pipeline with scripted provider usage (cache reads/writes), then
 * backdates timestamps so 30 days of history exist. Untracked dev tooling.
 *
 * Every request body embeds a unique nonce — the proxy replays duplicate
 * bodies idempotently and replayed requests never reach the mock upstreams,
 * which would desync the scripted usage queues.
 *
 * Run from apps/proxy:  npx tsx scripts/demo-caching-stack.ts
 * Admin API on :8899 (dev login local@example.com / dev-password).
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AddressInfo } from "node:net";

import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase, defaultWorkspaceId } from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";

import { buildModelCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { buildServer } from "../src/server.js";

type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};
type OpenAIUsage = {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details: { cached_tokens: number };
};

const anthropicQueue: AnthropicUsage[] = [];
const openaiQueue: OpenAIUsage[] = [];

const MINUTE = 60_000;
const DAY = 86_400_000;
const now = Date.now();

type Turn = {
  at: number;
  /** Routed via the classifier mock: tagged turns take the fast tier. */
  fast?: boolean;
  usage: { input: number; output: number; read?: number; write?: number };
  toolResults?: boolean;
};
type SessionPlan = {
  key: string;
  surface: "claude" | "codex";
  sessionId: string;
  turns: Turn[];
};

function agentSession(key: string, surface: "claude" | "codex", sessionId: string, startMsAgo: number, spec: {
  turns: number;
  context: number;
  growth: number;
  gapMinutes?: number;
}): SessionPlan {
  const turns: Turn[] = [];
  for (let index = 0; index < spec.turns; index += 1) {
    const context = spec.context + index * spec.growth;
    turns.push({
      at: now - startMsAgo + index * (spec.gapMinutes ?? 2) * MINUTE,
      usage: index === 0
        ? { input: Math.round(context * 0.1), output: 350, write: context }
        : { input: Math.round(context * 0.06), output: 420, read: context, write: Math.round(spec.growth * 0.8) },
      toolResults: index > 0
    });
  }
  return { key, surface, sessionId, turns };
}

const plans: SessionPlan[] = [
  // claude-web s1: warm prefix, then a fast-tier turn busts it (model switch).
  {
    key: "claude-web",
    surface: "claude",
    sessionId: "claude-web-s1",
    turns: [
      { at: now - 9 * DAY, usage: { input: 700, output: 380, write: 7200 } },
      { at: now - 9 * DAY + 3 * MINUTE, usage: { input: 250, output: 410, read: 7900, write: 150 }, toolResults: true },
      { at: now - 9 * DAY + 5 * MINUTE, usage: { input: 300, output: 350, read: 8200 }, toolResults: true },
      { at: now - 9 * DAY + 6 * MINUTE, fast: true, usage: { input: 600, output: 300, write: 8400 } },
      { at: now - 9 * DAY + 8 * MINUTE, fast: true, usage: { input: 200, output: 320, read: 8600, write: 100 }, toolResults: true }
    ]
  },
  // claude-web s2: TTL EXPIRY bust (9+ minute idle gap).
  {
    key: "claude-web",
    surface: "claude",
    sessionId: "claude-web-s2",
    turns: [
      { at: now - 4 * DAY, usage: { input: 900, output: 400, write: 9000 } },
      { at: now - 4 * DAY + 2 * MINUTE, usage: { input: 260, output: 380, read: 9200, write: 200 }, toolResults: true },
      { at: now - 4 * DAY + 11 * MINUTE, usage: { input: 280, output: 360, write: 9400 }, toolResults: true },
      { at: now - 4 * DAY + 14 * MINUTE, usage: { input: 240, output: 340, read: 9600 }, toolResults: true }
    ]
  },
  // agent-concierge: an UNKNOWN-cause bust (same model, inside the TTL).
  {
    key: "agent-concierge",
    surface: "claude",
    sessionId: "concierge-s1",
    turns: [
      { at: now - 2 * DAY, usage: { input: 500, output: 300, write: 5200 } },
      { at: now - 2 * DAY + 90_000, usage: { input: 220, output: 280, read: 5400, write: 120 }, toolResults: true },
      { at: now - 2 * DAY + 3.5 * MINUTE, usage: { input: 230, output: 310, write: 5600 }, toolResults: true },
      { at: now - 2 * DAY + 6 * MINUTE, usage: { input: 210, output: 290, read: 5800 }, toolResults: true }
    ]
  },
  // codex-prod: an OpenAI TTL EXPIRY bust.
  {
    key: "codex-prod",
    surface: "codex",
    sessionId: "codex-bust-s1",
    turns: [
      { at: now - 6 * DAY, usage: { input: 6000, output: 500 } },
      { at: now - 6 * DAY + 2 * MINUTE, usage: { input: 6400, output: 520, read: 5800 }, toolResults: true },
      { at: now - 6 * DAY + 10 * MINUTE, usage: { input: 6800, output: 480 }, toolResults: true },
      { at: now - 6 * DAY + 12 * MINUTE, usage: { input: 7100, output: 510, read: 6500 }, toolResults: true }
    ]
  }
];

// Daily background: long codex agent sessions (high hit rate) plus rotating
// batch/eval fast-tier singles that never reuse a prefix.
for (let day = 29; day >= 0; day -= 1) {
  const wobble = 1 + 0.35 * Math.sin(day * 1.7) + 0.2 * Math.sin(day * 0.6);
  plans.push(agentSession("codex-prod", "codex", `codex-daily-${day}`, day * DAY + 5 * 3_600_000, {
    turns: 4 + (day % 3),
    context: Math.round(5200 * wobble),
    growth: 700,
    gapMinutes: 2
  }));
  if (day % 2 === 0) {
    plans.push(agentSession("claude-web", "claude", `claude-daily-${day}`, day * DAY + 8 * 3_600_000, {
      turns: 3 + (day % 2),
      context: Math.round(6800 * wobble),
      growth: 900,
      gapMinutes: 3
    }));
  }
  if (day % 3 === 0) {
    plans.push({
      key: "batch-pipeline",
      surface: "codex",
      sessionId: `batch-${day}`,
      turns: [0, 1, 2].map((index) => ({
        at: now - day * DAY + 11 * 3_600_000 + index * 4 * MINUTE,
        fast: true,
        usage: { input: 3000 + index * 120, output: 250, read: 620 }
      }))
    });
  }
  if (day % 4 === 0) {
    plans.push({
      key: "eval-harness",
      surface: "claude",
      sessionId: `eval-${day}`,
      turns: [{
        at: now - day * DAY + 13 * 3_600_000,
        fast: true,
        usage: { input: 1400, output: 200, read: day % 8 === 0 ? 60 : 0 }
      }]
    });
  }
}
const totalTurns = plans.reduce((sum, plan) => sum + plan.turns.length, 0);

const openai = await mockOpenAI();
const anthropic = await mockAnthropic();
const demoEnv = {
  ...process.env,
  DATABASE_URL: "",
  EVENT_STORE_PATH: "",
  PORT: "8899",
  PROMPT_PROXY_TOKEN: "demo-default-token",
  OPENAI_API_KEY: "openai-upstream-key",
  ANTHROPIC_API_KEY: "anthropic-upstream-key",
  OPENAI_BASE_URL: openai.url,
  ANTHROPIC_BASE_URL: anthropic.url,
  ANTHROPIC_HARD_MODEL: "claude-opus-4-8",
  ANTHROPIC_FAST_MODEL: "claude-haiku-4-5",
  OPENAI_HARD_MODEL: "gpt-5.5",
  OPENAI_FAST_MODEL: "gpt-5.4-mini",
  CLASSIFIER_PROVIDER: "openai",
  CLASSIFIER_MODEL: "route-classifier-cheap",
  ADMIN_DEV_LOGIN_ENABLED: "true",
  ADMIN_CORS_ORIGIN: "http://127.0.0.1:5273,http://localhost:5273",
  LOG_LEVEL: "error"
};

const config = loadConfig(demoEnv);
const client = new PGlite();
const migrationsDir = join(process.cwd(), "../../packages/db/migrations");
for (const file of (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort()) {
  await client.exec(await readFile(join(migrationsDir, file), "utf8"));
}
const db = createPgliteDatabase(client);
await seedDatabase(db, seedOptionsFromEnv(demoEnv));
const persistence = createDatabasePersistence(db, buildModelCatalog(config), config, false);
const app = buildServer(config, { persistence });
await app.listen({ port: config.port, host: "127.0.0.1" });
const proxyUrl = `http://127.0.0.1:${config.port}`;
console.log(`[demo] proxy + admin API on ${proxyUrl}`);

const organizationId = config.defaultOrganizationId;
const workspaceId = defaultWorkspaceId(organizationId);
const keySecrets = new Map<string, string>();
for (const name of ["codex-prod", "claude-web", "agent-concierge", "batch-pipeline", "eval-harness"]) {
  const created = await persistence.apiKeyAdmin.createApiKey({
    organizationId,
    workspaceId,
    actorUserId: config.seedUserId,
    body: { name }
  });
  keySecrets.set(name, created.secret);
}
console.log(`[demo] created ${keySecrets.size} api keys`);

let sent = 0;
for (const plan of plans) {
  for (const [index, turn] of plan.turns.entries()) {
    const secret = keySecrets.get(plan.key)!;
    const response = plan.surface === "claude"
      ? await claudeRequest(secret, plan.sessionId, turn, index)
      : await codexRequest(secret, plan.sessionId, turn, index);
    await response.text();
    if (!response.ok) {
      throw new Error(`request failed (${plan.sessionId}#${index}): ${response.status}`);
    }
    sent += 1;
  }
}
console.log(`[demo] sent ${sent}/${totalTurns} requests through the pipeline`);

// Session linking and ledger writes land via async projections; wait for them
// to settle before rewriting timestamps.
let linked = 0;
let stable = 0;
for (let attempt = 0; attempt < 360 && stable < 6; attempt += 1) {
  const { rows } = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM requests WHERE session_id IS NOT NULL"
  );
  const current = rows[0]?.count ?? 0;
  stable = current === linked && current > 0 ? stable + 1 : 0;
  linked = current;
  if (linked >= sent) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.log(`[demo] ${linked}/${sent} requests linked to sessions`);

await backdate();
console.log("[demo] backdated timestamps; stack is ready — Ctrl-C to stop");
await new Promise(() => undefined);

function turnPrompt(sessionId: string, index: number, fast: boolean | undefined) {
  const nonce = randomBytes(6).toString("hex");
  // The [fast] tag steers the classifier mock; the nonce defeats idempotent replay.
  return `${fast ? "[fast] " : ""}Turn ${index} of ${sessionId} (${nonce}): the retry test is flaky on CI again, dig into the backoff jitter and fix the root cause.`;
}

function claudeRequest(secret: string, sessionId: string, turn: Turn, index: number) {
  anthropicQueue.push({
    input_tokens: turn.usage.input,
    output_tokens: turn.usage.output,
    cache_read_input_tokens: turn.usage.read ?? 0,
    cache_creation_input_tokens: turn.usage.write ?? 0
  });
  const history = Array.from({ length: Math.min(index, 4) }, (_, turnIndex) => ([
    { role: "user", content: `Earlier instruction ${turnIndex} in ${sessionId}: tighten the failing integration suite.` },
    { role: "assistant", content: `Acknowledged ${turnIndex}. I inspected the fixtures and patched the harness setup.` }
  ])).flat();
  const toolResults = turn.toolResults
    ? [{
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `tool-${index}`,
            content: [{ type: "text", text: `$ vitest run\n${"FAIL src/case.test.ts › retries flaky network call\n".repeat(18)}` }]
          }
        ]
      }]
    : [];
  return fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": sessionId
    },
    body: JSON.stringify({
      model: "claude-router-auto",
      system: `You are a careful coding agent for the payments platform. ${"Follow the workspace conventions, run the linter before committing, never push directly to main, and keep diffs minimal. ".repeat(30)}`,
      tools: [
        { name: "bash", description: "Run shell commands", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } } },
        { name: "read", description: "Read files", input_schema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } } } },
        { name: "grep", description: "Search file contents", input_schema: { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string" } } } },
        { name: "mcp__github__create_issue", description: "Create a GitHub issue", input_schema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } } } } },
        { name: "mcp__github__list_pull_requests", description: "List PRs", input_schema: { type: "object", properties: { state: { type: "string" }, base: { type: "string" } } } }
      ],
      messages: [
        ...history,
        ...toolResults,
        { role: "user", content: turnPrompt(sessionId, index, turn.fast) }
      ],
      stream: true,
      max_tokens: 2048
    })
  });
}

function codexRequest(secret: string, sessionId: string, turn: Turn, index: number) {
  // OpenAI reports input_tokens INCLUSIVE of cached tokens; the plan's
  // exclusive-style numbers (fresh input + read + write) fold into the total.
  const read = turn.usage.read ?? 0;
  openaiQueue.push({
    input_tokens: turn.usage.input + read + (turn.usage.write ?? 0),
    output_tokens: turn.usage.output,
    input_tokens_details: { cached_tokens: read }
  });
  const history = Array.from({ length: Math.min(index, 4) }, (_, turnIndex) => ([
    { type: "message", role: "user", content: [{ type: "input_text", text: `Earlier ask ${turnIndex} in ${sessionId}: profile the slow dashboard query.` }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: `Done ${turnIndex}: added an index and memoized the resolver.` }] }
  ])).flat();
  return fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-codex-session-id": sessionId
    },
    body: JSON.stringify({
      model: "router-auto",
      instructions: `You are the production web agent. ${"Prefer surgical diffs, keep telemetry intact, and annotate every schema change. ".repeat(24)}`,
      input: [
        ...history,
        { type: "message", role: "user", content: [{ type: "input_text", text: turnPrompt(sessionId, index, turn.fast) }] }
      ],
      tools: [
        { type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "string" } } } },
        { type: "function", name: "apply_patch", parameters: { type: "object", properties: { patch: { type: "string" } } } }
      ],
      stream: true
    })
  });
}

async function backdate() {
  let missing = 0;
  for (const plan of plans) {
    const { rows: sessionRows } = await client.query<{ id: string }>(
      "SELECT id FROM agent_sessions WHERE external_session_id = $1",
      [plan.sessionId]
    );
    const internalId = sessionRows[0]?.id;
    if (!internalId) {
      missing += plan.turns.length;
      continue;
    }
    const { rows: requestRows } = await client.query<{ id: string }>(
      "SELECT id FROM requests WHERE session_id = $1 ORDER BY created_at",
      [internalId]
    );
    if (requestRows.length !== plan.turns.length) {
      missing += plan.turns.length - requestRows.length;
    }
    for (const [index, row] of requestRows.entries()) {
      const at = new Date(plan.turns[Math.min(index, plan.turns.length - 1)].at).toISOString();
      await client.query("UPDATE requests SET created_at = $1, completed_at = $1 WHERE id = $2", [at, row.id]);
      await client.query("UPDATE usage_ledger SET created_at = $1 WHERE request_id = $2", [at, row.id]);
      await client.query("UPDATE events SET created_at = $1 WHERE scope_id = $2", [at, row.id]);
    }
    const startedAt = new Date(plan.turns[0].at).toISOString();
    const endedAt = new Date(plan.turns[plan.turns.length - 1].at).toISOString();
    await client.query(
      "UPDATE agent_sessions SET started_at = $1, updated_at = $2 WHERE id = $3",
      [startedAt, endedAt, internalId]
    );
  }
  if (missing > 0) console.warn(`[demo] ${missing} requests were not matched while backdating`);
}

async function mockOpenAI() {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    if (body.model === "route-classifier-cheap") {
      const fast = JSON.stringify(body).includes("[fast]");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        output_text: JSON.stringify({
          complexity: fast ? "simple" : "hard",
          risk: [],
          recommended_route: fast ? "fast" : "hard",
          can_use_fast_model: fast,
          needs_deep_reasoning: !fast,
          reason_codes: ["demo"],
          confidence: 0.92
        })
      }));
      return;
    }
    const usage = openaiQueue.shift() ?? { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Reconciled the drift; ledger matches the provider statement now." })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "response.completed", response: { id: `resp_${Math.random().toString(36).slice(2)}`, usage } })}\n\n`);
    response.end();
  });
  return listen(server);
}

async function mockAnthropic() {
  const server = createServer(async (request, response) => {
    await readJson(request);
    const usage = anthropicQueue.shift() ?? {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      type: "message_start",
      message: { id: `msg_${Math.random().toString(36).slice(2)}`, usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, output_tokens: 0 } }
    })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Patched the jitter window; retries are deterministic in CI now." } })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: usage.output_tokens } })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
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
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

function readJson(request: IncomingMessage) {
  return new Promise<any>((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
}
