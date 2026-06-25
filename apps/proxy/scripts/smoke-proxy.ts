import { createServer, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { defaultWorkspaceId } from "@proxy/db";

import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { createSmokePersistence } from "./smoke-persistence.js";
import type { RoutingConfig } from "@proxy/schema";
import { assertPersistedRoutingDecision } from "./smoke-routing-assertions.js";

type Recorded = {
  path: string;
  body: any;
};

const openaiRecords: Recorded[] = [];
const anthropicRecords: Recorded[] = [];

const openai = await mockOpenAI(openaiRecords);
const anthropic = await mockAnthropic(anthropicRecords);
const smokeEnv = {
  ...process.env,
  DATABASE_URL: "",
  EVENT_STORE_PATH: "",
  PROXY_TOKEN: "proxy-token",
  OPENAI_API_KEY: "openai-upstream-key",
  ANTHROPIC_API_KEY: "anthropic-upstream-key",
  OPENAI_BASE_URL: openai.url,
  OPENAI_FAST_MODEL: "gpt-5.4-mini",
  OPENAI_HARD_MODEL: "gpt-5.5",
  ANTHROPIC_BASE_URL: anthropic.url,
  ANTHROPIC_FAST_MODEL: "claude-haiku-4-5",
  ANTHROPIC_HARD_MODEL: "claude-sonnet-4-6",
  CLASSIFIER_PROVIDER: "openai",
  CLASSIFIER_MODEL: "route-classifier-cheap",
  LOG_LEVEL: "error"
};
const config = loadConfig(smokeEnv);
const smokePersistence = await createSmokePersistence(config, smokeEnv);
const app = buildServer(config, { persistence: smokePersistence.persistence });
const smokeAdminQueries = smokePersistence.persistence.adminQueries.forScope(
  config.defaultOrganizationId,
  defaultWorkspaceId(config.defaultOrganizationId)
);
const defaultRoutingConfigId = `${config.defaultOrganizationId}:routing-config:default`;

try {
  const proxyUrl = await app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  });

  await drainOk(
    await codexRequest(proxyUrl, "smoke-codex-default", "fix the failing auth test and find root cause"),
    "Codex default request was rejected"
  );
  await drainOk(
    await claudeRequest(proxyUrl, "smoke-claude-default", "debug this flaky auth regression"),
    "Claude default request was rejected"
  );

  assertClassifierCalls(2, openaiRecords);
  assertProviderCall(openaiRecords, config.openaiHardModel, "Codex default");
  assertProviderCall(anthropicRecords, config.anthropicHardModel, "Claude default");
  await assertPersistedRoutingDecision(smokeAdminQueries, {
    label: "Codex default",
    surface: "openai-responses",
    finalRoute: "hard",
    selectedModel: config.openaiHardModel,
    routingConfigId: defaultRoutingConfigId
  });
  await assertPersistedRoutingDecision(smokeAdminQueries, {
    label: "Claude default",
    surface: "anthropic-messages",
    finalRoute: "hard",
    selectedModel: config.anthropicHardModel,
    routingConfigId: defaultRoutingConfigId
  });

  const assigned = await assignSmokeRoutingConfig();

  await drainOk(
    await codexRequest(proxyUrl, "smoke-codex-assigned", "fix the failing auth test and find root cause after reassignment"),
    "Codex reassigned request was rejected"
  );
  await drainOk(
    await claudeRequest(proxyUrl, "smoke-claude-assigned", "debug this flaky auth regression after reassignment"),
    "Claude reassigned request was rejected"
  );

  assertClassifierCalls(4, openaiRecords);
  assertProviderCall(openaiRecords, config.openaiFastModel, "Codex reassigned");
  assertProviderCall(anthropicRecords, config.anthropicFastModel, "Claude reassigned");
  await assertPersistedRoutingDecision(smokeAdminQueries, {
    label: "Codex reassigned",
    surface: "openai-responses",
    finalRoute: "hard",
    selectedModel: config.openaiFastModel,
    routingConfigId: assigned.configId
  });
  await assertPersistedRoutingDecision(smokeAdminQueries, {
    label: "Claude reassigned",
    surface: "anthropic-messages",
    finalRoute: "hard",
    selectedModel: config.anthropicFastModel,
    routingConfigId: assigned.configId
  });

  console.log(`codex_default_route=hard model=${config.openaiHardModel} config=${defaultRoutingConfigId}`);
  console.log(`claude_default_route=hard model=${config.anthropicHardModel} config=${defaultRoutingConfigId}`);
  console.log(`codex_reassigned_route=hard model=${config.openaiFastModel} config=${assigned.configId}`);
  console.log(`claude_reassigned_route=hard model=${config.anthropicFastModel} config=${assigned.configId}`);
} finally {
  await app.close();
  await smokePersistence.close();
  await openai.close();
  await anthropic.close();
}

function codexRequest(proxyUrl: string, sessionId: string, input: string) {
  return fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json",
      "x-codex-session-id": sessionId
    },
    body: JSON.stringify({
      model: "router-auto",
      input,
      tools: [{ type: "function", name: "shell" }],
      stream: true
    })
  });
}

function claudeRequest(proxyUrl: string, sessionId: string, content: string) {
  return fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": sessionId
    },
    body: JSON.stringify({
      model: "claude-router-auto",
      messages: [{ role: "user", content }],
      tools: [{ name: "bash", input_schema: { type: "object" } }],
      stream: true,
      max_tokens: 2048
    })
  });
}

async function drainOk(response: Response, message: string) {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${failurePhase(response.status, body)} failed: ${message}. status=${response.status} body=${body}`);
  }
}

function failurePhase(status: number, body: string) {
  if (status === 401 || status === 403) return "auth";
  if (/routing_config|config resolution/i.test(body)) return "config resolution";
  if (/classif/i.test(body)) return "classifier";
  if (/provider|upstream|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(body)) return "provider forwarding";
  return "proxy request";
}

async function assignSmokeRoutingConfig() {
  const resolved = await smokePersistence.persistence.routingConfigs.resolve({
    organizationId: config.defaultOrganizationId,
    workspaceId: defaultWorkspaceId(config.defaultOrganizationId),
    routingConfigId: defaultRoutingConfigId
  });
  const assignedConfig = structuredClone(resolved.config) as RoutingConfig;
  assignedConfig.displayName = "Smoke reassigned coding router";
  assignedConfig.description = "Smoke-only routing config that maps hard traffic to the fast model tier.";

  const hard = assignedConfig.routes.hard;
  if (!hard.openai?.deployments[0] || !hard.anthropic?.deployments[0]) {
    throw new Error("config resolution failed: seeded hard route is missing provider settings");
  }
  hard.openai = {
    ...hard.openai,
    deployments: [{
      ...hard.openai.deployments[0],
      model: config.openaiFastModel,
      reasoning: { effort: "low" },
      text: { verbosity: "low" }
    }]
  };
  hard.anthropic = {
    ...hard.anthropic,
    deployments: [{
      ...hard.anthropic.deployments[0],
      model: config.anthropicFastModel,
      thinking: { type: "disabled" },
      output_config: { effort: "low" }
    }]
  };

  const created = await smokePersistence.persistence.routingConfigAdmin.createConfig({
    organizationId: config.defaultOrganizationId,
    workspaceId: defaultWorkspaceId(config.defaultOrganizationId),
    actorUserId: config.seedUserId,
    body: {
      name: "Smoke reassigned routing config",
      slug: "smoke-reassigned",
      description: "Used by smoke tests to prove API-key routing assignment changes are honored.",
      config: assignedConfig
    }
  });
  await smokePersistence.persistence.routingConfigAdmin.assignApiKeyRoutingConfig({
    organizationId: config.defaultOrganizationId,
    workspaceId: defaultWorkspaceId(config.defaultOrganizationId),
    actorUserId: config.seedUserId,
    apiKeyId: `${config.defaultOrganizationId}:api-key:default`,
    body: {
      routingConfigId: created.configId
    }
  });
  return created;
}

function assertClassifierCalls(expected: number, records: Recorded[]) {
  const actual = records.filter((record) => record.body.model === config.classifierModel).length;
  if (actual < expected) {
    throw new Error(
      `classifier failed: expected at least ${expected} classifier calls, saw ${actual}. records=${JSON.stringify(records)}`
    );
  }
}

function assertProviderCall(records: Recorded[], model: string, label: string) {
  const found = records.some((record) => record.body.model === model);
  if (!found) {
    throw new Error(
      `provider forwarding failed: ${label} did not send model=${model}. records=${JSON.stringify(records)}`
    );
  }
}

async function mockOpenAI(records: Recorded[]) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", body });

    if (body.model === "route-classifier-cheap") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          output_text: JSON.stringify({
            complexity: "hard",
            risk: ["auth"],
            recommended_route: "hard",
            can_use_fast_model: false,
            needs_deep_reasoning: false,
            reason_codes: ["auth_risk", "tools_present"],
            confidence: 0.88
          })
        })
      );
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_smoke", usage: { input_tokens: 10, output_tokens: 5 } }
      })}\n\n`
    );
    response.end();
  });

  return listen(server);
}

async function mockAnthropic(records: Recorded[]) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", body });

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_smoke", usage: { input_tokens: 10, output_tokens: 0 } }
      })}\n\n`
    );
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
