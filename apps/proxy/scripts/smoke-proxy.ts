import { createServer, type IncomingMessage } from "node:http";
import { type AddressInfo } from "node:net";

import { defaultWorkspaceId } from "@proxy/db";

import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import {
  assertPersistedGatewayResolution
} from "./smoke-gateway-assertions.js";
import { createSmokePersistence } from "./smoke-persistence.js";

type Recorded = {
  path: string;
  body: Record<string, unknown>;
};

const classifierModel = "route-classifier-cheap";
const codingModel = "gpt-5.4-mini";
const fableModel = "claude-fable-5";
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
  ANTHROPIC_BASE_URL: anthropic.url,
  GATEWAY_SEED_CLASSIFIER_MODEL: classifierModel,
  ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.1/32",
  LOG_LEVEL: "error"
};
const config = loadConfig(smokeEnv);
const smokePersistence = await createSmokePersistence(config, smokeEnv);
const app = buildServer(config, { persistence: smokePersistence.persistence });
const workspaceId = defaultWorkspaceId(config.defaultOrganizationId);
const accessProfileId = `${workspaceId}:access-profile:opendoor-engineer`;

try {
  const proxyUrl = await app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  });

    await assertLogicalModels(proxyUrl);
  await drainOk(
    await openAIRequest(proxyUrl, "smoke-coding-auto", "fix the failing auth test and find the root cause"),
    "OpenAI-compatible auto-routing request was rejected"
  );
  await drainOk(
    await anthropicRequest(proxyUrl, "smoke-fable", "explain the failing auth regression"),
    "Anthropic-compatible direct-model request was rejected"
  );

  assertProviderCall(openaiRecords, codingModel, "coding-auto");
  assertProviderCall(anthropicRecords, fableModel, "fable");
  assertClassifierCalls(openaiRecords);

  const adminQueries = smokePersistence.persistence.adminQueries.forScope(
    config.defaultOrganizationId,
    workspaceId
  );
  await assertPersistedGatewayResolution(adminQueries, {
    label: "coding-auto",
    surface: "openai-responses",
    requestedLogicalModel: "coding-auto",
    resolvedLogicalModelId: `${workspaceId}:logical-model:coding-auto`,
    accessProfileId,
    selectedModel: codingModel,
    deploymentId: `${workspaceId}:deployment:openai:${codingModel}`,
    providerConnectionId: `${workspaceId}:connection:openai`,
    ingressWireId: "openai-responses",
    egressWireId: "openai-responses"
  });
  await assertPersistedGatewayResolution(adminQueries, {
    label: "fable",
    surface: "anthropic-messages",
    requestedLogicalModel: "fable",
    resolvedLogicalModelId: `${workspaceId}:logical-model:fable`,
    accessProfileId,
    selectedModel: fableModel,
    deploymentId: `${workspaceId}:deployment:anthropic:${fableModel}`,
    providerConnectionId: `${workspaceId}:connection:anthropic`,
    ingressWireId: "anthropic-messages",
    egressWireId: "anthropic-messages"
  });

  console.log(`coding_auto_model=${codingModel} deployment=${workspaceId}:deployment:openai:${codingModel}`);
  console.log(`fable_model=${fableModel} deployment=${workspaceId}:deployment:anthropic:${fableModel}`);
} finally {
  await app.close();
  await smokePersistence.close();
  await openai.close();
  await anthropic.close();
}

async function assertLogicalModels(proxyUrl: string) {
  const response = await fetch(`${proxyUrl}/v1/models`, {
    headers: { authorization: "Bearer proxy-token" }
  });
  const body = asRecord(await response.json());
  const ids = Array.isArray(body.data)
    ? body.data.map((entry) => asString(asRecord(entry).id)).filter((value): value is string => Boolean(value))
    : [];
  for (const expected of ["coding-auto", "economy-auto", "fable"]) {
    if (!ids.includes(expected)) {
      throw new Error(`logical model listing failed: missing ${expected}. models=${JSON.stringify(ids)}`);
    }
  }
}

function openAIRequest(proxyUrl: string, sessionId: string, input: string) {
  return fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json",
      "x-codex-session-id": sessionId
    },
    body: JSON.stringify({
      model: "coding-auto",
      input,
      tools: [{ type: "function", name: "shell" }],
      stream: true
    })
  });
}

function anthropicRequest(proxyUrl: string, sessionId: string, content: string) {
  return fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": sessionId
    },
    body: JSON.stringify({
      model: "fable",
      messages: [{ role: "user", content }],
      stream: true,
      max_tokens: 64
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
  if (/gateway|logical_model|model_access/i.test(body)) return "gateway resolution";
  if (/classif/i.test(body)) return "classifier";
  if (/provider|upstream|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(body)) return "provider forwarding";
  return "proxy request";
}

function assertClassifierCalls(records: Recorded[]) {
  if (!records.some((record) => record.body.model === classifierModel)) {
    throw new Error(`classifier failed: no ${classifierModel} call. records=${JSON.stringify(records)}`);
  }
}

function assertProviderCall(records: Recorded[], model: string, label: string) {
  if (!records.some((record) => record.body.model === model)) {
    throw new Error(`provider forwarding failed: ${label} did not send model=${model}. records=${JSON.stringify(records)}`);
  }
}

async function mockOpenAI(records: Recorded[]) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", body });

    if (body.model === classifierModel) {
      const targetId = firstClassifierTarget(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        output_text: JSON.stringify({
          target_id: targetId,
          reason_codes: ["smoke_first_eligible"],
          confidence: 0.9
        })
      }));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_smoke", usage: { input_tokens: 10, output_tokens: 5 } }
    })}\n\n`);
    response.end();
  });

  return listen(server);
}

async function mockAnthropic(records: Recorded[]) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", body });

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      type: "message_start",
      message: { id: "msg_smoke", usage: { input_tokens: 10, output_tokens: 0 } }
    })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    response.end();
  });

  return listen(server);
}

function firstClassifierTarget(body: Record<string, unknown>) {
  const input = asString(body.input);
  const parsed = input ? asRecord(JSON.parse(input)) : {};
  const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
  const targetId = asString(asRecord(targets[0]).id);
  if (!targetId) throw new Error(`classifier request has no candidates: ${JSON.stringify(body)}`);
  return targetId;
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
  return new Promise<Record<string, unknown>>((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => resolve(body ? asRecord(JSON.parse(body)) : {}));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
