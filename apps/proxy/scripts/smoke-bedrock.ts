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
  body: any;
};

const requiredEnv = ["AWS_REGION", "AWS_BEDROCK_TEST_MODEL"].filter((key) => !process.env[key]?.trim());
if (requiredEnv.length > 0) {
  console.log(`bedrock_smoke=skipped missing_env=${requiredEnv.join(",")}`);
  console.log("bedrock_smoke_expected_env=AWS_REGION,AWS_BEDROCK_TEST_MODEL");
  process.exit(0);
}

const region = process.env.AWS_REGION!.trim();
const bedrockModel = process.env.AWS_BEDROCK_TEST_MODEL!.trim();

const operatorOpenAIRecords: Recorded[] = [];
const anthropicRecords: Recorded[] = [];
const operatorOpenAI = await mockOperatorOpenAI(operatorOpenAIRecords);
const anthropic = await mockAnthropic(anthropicRecords);

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
  BEDROCK_OPERATOR_DEFAULT_CHAIN_ENABLED: "true",
  BEDROCK_LOCAL_CREDENTIALS_ENABLED: "true",
  LOG_LEVEL: "fatal"
};
const config = loadConfig(smokeEnv);
const smokePersistence = await createSmokePersistence(config, smokeEnv);
const app = buildServer(config, { persistence: smokePersistence.persistence });
const workspaceId = defaultWorkspaceId(config.defaultOrganizationId);
const bedrockProviderAccountId = `${config.defaultOrganizationId}:provider:amazon-bedrock`;
const defaultApiKeyId = `${config.defaultOrganizationId}:api-key:default`;
const defaultRoutingConfigId = `${config.defaultOrganizationId}:routing-config:default`;
const smokeAdminQueries = smokePersistence.persistence.adminQueries.forScope(config.defaultOrganizationId, workspaceId);

try {
  const assigned = await configureBedrockRoute();
  const proxyUrl = await app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  });

  await drainOk(
    await openAIChatRequest(proxyUrl),
    "Bedrock OpenAI Chat request was rejected"
  );
  await drainOk(
    await anthropicMessagesRequest(proxyUrl),
    "Bedrock Anthropic Messages request was rejected"
  );
  await drainOk(
    await openAIResponsesRequest(proxyUrl, false),
    "Bedrock stateless OpenAI Responses request was rejected"
  );
  const unsupported = await unsupportedStatefulResponses(proxyUrl);

  await assertPersistedRoutingDecision(smokeAdminQueries, {
    label: "Bedrock OpenAI Chat",
    surface: "openai-chat",
    finalRoute: "hard",
    selectedModel: bedrockModel,
    routingConfigId: assigned.configId
  });
  await assertPersistedRoutingDecision(smokeAdminQueries, {
    label: "Bedrock Anthropic Messages",
    surface: "anthropic-messages",
    finalRoute: "hard",
    selectedModel: bedrockModel,
    routingConfigId: assigned.configId
  });
  await assertPersistedRoutingDecision(smokeAdminQueries, {
    label: "Bedrock stateless OpenAI Responses",
    surface: "openai-responses",
    finalRoute: "hard",
    selectedModel: bedrockModel,
    routingConfigId: assigned.configId
  });

  console.log(`bedrock_provider=amazon-bedrock region=${region} model=${bedrockModel} config=${assigned.configId}`);
  console.log(`bedrock_openai_chat=passed model=${bedrockModel} config=${assigned.configId}`);
  console.log(`bedrock_anthropic_messages=passed model=${bedrockModel} config=${assigned.configId}`);
  console.log(`bedrock_openai_responses_stateless=passed model=${bedrockModel} config=${assigned.configId}`);
  console.log(`bedrock_openai_responses_previous_response_id=unsupported status=${unsupported.status} reason=${unsupported.reason}`);
} finally {
  await app.close();
  await smokePersistence.close();
  await operatorOpenAI.close();
  await anthropic.close();
}

async function configureBedrockRoute() {
  await smokePersistence.persistence.providerCredentialAdmin.updateCredential({
    organizationId: config.defaultOrganizationId,
    actorUserId: config.seedUserId,
    providerAccountId: bedrockProviderAccountId,
    body: {
      credentialMode: "aws_default_chain",
      region,
      discoveryRegions: [region]
    }
  });
  await smokePersistence.persistence.providerCredentialAdmin.bindApiKeyCredential({
    organizationId: config.defaultOrganizationId,
    workspaceId,
    actorUserId: config.seedUserId,
    apiKeyId: defaultApiKeyId,
    body: {
      provider: "amazon-bedrock",
      providerAccountId: bedrockProviderAccountId
    }
  });
  await smokePersistence.persistence.modelCatalogAdmin.upsertManualModel({
    organizationId: config.defaultOrganizationId,
    actorUserId: config.seedUserId,
    body: {
      provider: "amazon-bedrock",
      model: bedrockModel,
      displayName: bedrockModel,
      dialects: ["bedrock-converse"],
      contextWindow: 200000,
      maxOutputTokens: 4096,
      supportsStreaming: true,
      supportsTools: false,
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
  routingConfig.displayName = "Bedrock smoke";
  routingConfig.description = "Smoke-only config that routes hard caller surfaces to Amazon Bedrock Converse.";
  routingConfig.routes.hard = {
    ...routingConfig.routes.hard,
    openai: {
      deployments: [{
        provider: "amazon-bedrock",
        providerAccountId: bedrockProviderAccountId,
        model: bedrockModel,
        order: 0,
        weight: 1,
        timeoutMs: 60000,
        maxOutputTokens: 64,
        metadata: {
          bedrock: { region }
        }
      }]
    },
    anthropic: {
      deployments: [{
        provider: "amazon-bedrock",
        providerAccountId: bedrockProviderAccountId,
        model: bedrockModel,
        order: 0,
        weight: 1,
        timeoutMs: 60000,
        maxTokens: 64,
        metadata: {
          bedrock: { region }
        }
      }]
    }
  };

  const created = await smokePersistence.persistence.routingConfigAdmin.createConfig({
    organizationId: config.defaultOrganizationId,
    workspaceId,
    actorUserId: config.seedUserId,
    body: {
      name: "Bedrock smoke",
      description: "Used by smoke tests to prove caller surfaces can route to Bedrock.",
      config: routingConfig
    }
  });
  await smokePersistence.persistence.routingConfigAdmin.assignApiKeyRoutingConfig({
    organizationId: config.defaultOrganizationId,
    workspaceId,
    actorUserId: config.seedUserId,
    apiKeyId: defaultApiKeyId,
    body: {
      routingConfigId: created.configId
    }
  });
  return created;
}

function openAIChatRequest(proxyUrl: string) {
  return fetch(`${proxyUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "router-hard",
      messages: [{ role: "user", content: "Reply with the single word ok." }],
      max_tokens: 32,
      temperature: 0
    })
  });
}

function anthropicMessagesRequest(proxyUrl: string) {
  return fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-router-hard",
      messages: [{ role: "user", content: "Reply with the single word ok." }],
      max_tokens: 32
    })
  });
}

function openAIResponsesRequest(proxyUrl: string, previousResponse: boolean) {
  return fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "router-hard",
      input: "Reply with the single word ok.",
      max_output_tokens: 32,
      ...(previousResponse ? { previous_response_id: "resp_previous_bedrock_smoke" } : {})
    })
  });
}

async function unsupportedStatefulResponses(proxyUrl: string) {
  const response = await openAIResponsesRequest(proxyUrl, true);
  const body = await response.text();
  if (response.ok) {
    throw new Error(`unsupported path failed: Bedrock accepted previous_response_id. body=${body}`);
  }
  if (!/previous_response|stateful|target_unavailable_previous_response_id|previous_response_id_not_supported|route/i.test(body)) {
    throw new Error(
      `unsupported path failed: expected previous_response_id/stateful error. status=${response.status} body=${body}`
    );
  }
  return {
    status: response.status,
    reason: body.replace(/\s+/g, " ").trim().slice(0, 180)
  };
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
  if (/provider_not_found|provider_endpoint|model catalog|target model|credential/i.test(body)) return "provider setup";
  if (/bedrock|provider|upstream|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(body)) return "provider forwarding";
  return "proxy request";
}

async function mockOperatorOpenAI(records: Recorded[]) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", body });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        output_text: JSON.stringify({
          complexity: "hard",
          risk: ["smoke"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["bedrock_smoke"],
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
    records.push({ path: request.url ?? "", body });

    response.writeHead(200, { "content-type": "text/event-stream" });
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
