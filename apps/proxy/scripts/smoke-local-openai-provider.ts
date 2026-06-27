import { createServer, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { defaultWorkspaceId } from "@proxy/db";
import type { RoutingConfig } from "@proxy/schema";

import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { createSmokePersistence } from "./smoke-persistence.js";
import { assertPersistedRoutingDecision } from "./smoke-routing-assertions.js";

type Recorded = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
};

const LOCAL_PROVIDER_SLUG = "local-openai-compatible";
const LOCAL_MODEL = "local-oss-chat";

const operatorRecords: Recorded[] = [];
const anthropicRecords: Recorded[] = [];
const localProviderRecords: Recorded[] = [];

const operatorOpenAI = await mockOperatorOpenAI(operatorRecords);
const anthropic = await mockAnthropic(anthropicRecords);
const localProvider = await mockLocalOpenAI(localProviderRecords);

const smokeEnv = {
  ...process.env,
  DATABASE_URL: "",
  EVENT_STORE_PATH: "",
  PROXY_TOKEN: "proxy-token",
  OPENAI_API_KEY: "openai-upstream-key",
  ANTHROPIC_API_KEY: "anthropic-upstream-key",
  OPENAI_BASE_URL: operatorOpenAI.url,
  OPENAI_FAST_MODEL: "gpt-5.4-mini",
  OPENAI_HARD_MODEL: "gpt-5.5",
  ANTHROPIC_BASE_URL: anthropic.url,
  ANTHROPIC_FAST_MODEL: "claude-haiku-4-5",
  ANTHROPIC_HARD_MODEL: "claude-sonnet-4-6",
  CLASSIFIER_PROVIDER: "openai",
  CLASSIFIER_MODEL: "route-classifier-cheap",
  ALLOWED_PRIVATE_UPSTREAM_CIDRS: "127.0.0.0/8",
  LOG_LEVEL: "fatal"
};
const config = loadConfig(smokeEnv);
const smokePersistence = await createSmokePersistence(config, smokeEnv);
const app = buildServer(config, { persistence: smokePersistence.persistence });
const workspaceId = defaultWorkspaceId(config.defaultOrganizationId);
const defaultRoutingConfigId = `${config.defaultOrganizationId}:routing-config:default`;
const smokeAdminQueries = smokePersistence.persistence.adminQueries.forScope(config.defaultOrganizationId, workspaceId);

try {
  const assigned = await configureLocalProviderRoute();
  const proxyUrl = await app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  });

  await drainOk(
    await chatRequest(proxyUrl, false, "local-openai-nonstream"),
    "Local OpenAI-compatible non-streaming Chat request was rejected"
  );
  await drainOk(
    await chatRequest(proxyUrl, true, "local-openai-stream"),
    "Local OpenAI-compatible streaming Chat request was rejected"
  );

  assertLocalProviderCall(LOCAL_MODEL, false, "non-streaming Chat");
  assertLocalProviderCall(LOCAL_MODEL, true, "streaming Chat");
  await assertPersistedRoutingDecision(smokeAdminQueries, {
    label: "Local OpenAI-compatible Chat",
    surface: "openai-chat",
    finalRoute: "hard",
    selectedModel: LOCAL_MODEL,
    routingConfigId: assigned.configId
  });

  console.log(`local_openai_provider=${LOCAL_PROVIDER_SLUG} base_url=${localProvider.url}`);
  console.log(`local_openai_chat_nonstream=passed model=${LOCAL_MODEL} config=${assigned.configId}`);
  console.log(`local_openai_chat_stream=passed model=${LOCAL_MODEL} config=${assigned.configId}`);
} finally {
  await app.close();
  await smokePersistence.close();
  await operatorOpenAI.close();
  await anthropic.close();
  await localProvider.close();
}

async function configureLocalProviderRoute() {
  await smokePersistence.persistence.providerRegistryAdmin.createProvider({
    organizationId: config.defaultOrganizationId,
    actorUserId: config.seedUserId,
    body: {
      slug: LOCAL_PROVIDER_SLUG,
      displayName: "Local OpenAI Compatible",
      baseUrl: localProvider.url,
      authStyle: "none",
      endpoints: [{ dialect: "openai-chat", path: "/chat/completions" }],
      defaultHeaders: {},
      capabilities: {},
      forwardHarnessHeaders: false,
      enabled: true
    }
  });
  await smokePersistence.persistence.modelCatalogAdmin.upsertManualModel({
    organizationId: config.defaultOrganizationId,
    actorUserId: config.seedUserId,
    body: {
      provider: LOCAL_PROVIDER_SLUG,
      model: LOCAL_MODEL,
      displayName: "Local OSS Chat",
      dialects: ["openai-chat"],
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsStreaming: true,
      supportsTools: true,
      supportsImages: false,
      supportsReasoning: false,
      pricing: {
        inputCostPerMtok: 0,
        outputCostPerMtok: 0
      }
    }
  });

  const resolved = await smokePersistence.persistence.routingConfigs.resolve({
    organizationId: config.defaultOrganizationId,
    workspaceId,
    routingConfigId: defaultRoutingConfigId
  });
  const routingConfig = structuredClone(resolved.config) as RoutingConfig;
  routingConfig.displayName = "Local OpenAI-compatible smoke";
  routingConfig.description = "Smoke-only config that routes hard Chat traffic to a local OpenAI-compatible provider.";
  routingConfig.routes.hard = {
    ...routingConfig.routes.hard,
    anthropic: undefined,
    openai: {
      deployments: [{
        provider: LOCAL_PROVIDER_SLUG,
        model: LOCAL_MODEL,
        order: 0,
        weight: 1,
        timeoutMs: 30000
      }]
    }
  };

  const created = await smokePersistence.persistence.routingConfigAdmin.createConfig({
    organizationId: config.defaultOrganizationId,
    workspaceId,
    actorUserId: config.seedUserId,
    body: {
      name: "Local OpenAI-compatible smoke",
      description: "Used by smoke tests to prove custom OpenAI-compatible provider routing.",
      config: routingConfig
    }
  });
  await smokePersistence.persistence.routingConfigAdmin.assignApiKeyRoutingConfig({
    organizationId: config.defaultOrganizationId,
    workspaceId,
    actorUserId: config.seedUserId,
    apiKeyId: `${config.defaultOrganizationId}:api-key:default`,
    body: {
      routingConfigId: created.configId
    }
  });
  return created;
}

function chatRequest(proxyUrl: string, stream: boolean, content: string) {
  return fetch(`${proxyUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "router-hard",
      messages: [{ role: "user", content }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
      stream
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
  if (/provider_not_found|provider_endpoint|model catalog|target model/i.test(body)) return "provider setup";
  if (/provider|upstream|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(body)) return "provider forwarding";
  return "proxy request";
}

function assertLocalProviderCall(model: string, stream: boolean, label: string) {
  const found = localProviderRecords.some((record) =>
    record.path === "/chat/completions" &&
    record.body.model === model &&
    record.body.stream === stream
  );
  if (!found) {
    throw new Error(
      `provider forwarding failed: ${label} did not reach ${LOCAL_PROVIDER_SLUG} model=${model} stream=${stream}. records=${JSON.stringify(localProviderRecords)}`
    );
  }
}

async function mockOperatorOpenAI(records: Recorded[]) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", headers: request.headers, body });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        output_text: JSON.stringify({
          complexity: "hard",
          risk: ["smoke"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["local_openai_smoke"],
          confidence: 0.9
        })
      })
    );
  });

  return listen(server);
}

async function mockAnthropic(records: Recorded[]) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", headers: request.headers, body });

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    response.end();
  });

  return listen(server);
}

async function mockLocalOpenAI(records: Recorded[]) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", headers: request.headers, body });

    if (request.url !== "/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `expected /chat/completions got ${request.url}` } }));
      return;
    }

    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_local_smoke",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "local stream" }, finish_reason: null }],
        usage: null
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl_local_smoke",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
      })}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl_local_smoke",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "local ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
    }));
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
