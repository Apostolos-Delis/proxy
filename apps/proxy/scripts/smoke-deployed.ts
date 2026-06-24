import { randomBytes } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";

import WebSocket from "ws";

setDefaultResultOrder("ipv4first");

type SmokeResult = {
  surface: "openai-responses" | "anthropic-messages";
  transport: "sse" | "websocket";
  sessionId: string;
  route?: string;
  model?: string;
};

type AdminProof = {
  requestCount: number;
  promptCount: number;
  sessionCount: number;
};

const baseUrl = normalizeBaseUrl(requiredEnv([
  "PROXY_DEPLOYED_BASE_URL",
  "PROXY_BASE_URL"
]));
const apiKey = requiredEnv([
  "PROXY_DEPLOYED_API_KEY",
  "PROXY_TOKEN"
]);
const expectedOrganizationId = optionalEnv([
  "PROXY_DEPLOYED_ORGANIZATION_ID",
  "DEFAULT_ORGANIZATION_ID"
]);
const adminCookie = optionalEnv(["PROXY_DEPLOYED_ADMIN_COOKIE"]);
const adminEmail = optionalEnv([
  "PROXY_DEPLOYED_ADMIN_EMAIL",
  "ADMIN_DEV_LOGIN_EMAIL"
]);
const adminPassword = optionalEnv([
  "PROXY_DEPLOYED_ADMIN_PASSWORD",
  "ADMIN_DEV_LOGIN_PASSWORD"
]);
const skipAdmin = booleanEnv(process.env.PROXY_DEPLOYED_SKIP_ADMIN);
const marker = `deployed-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`;

try {
  await smokeHealth();
  await smokeModels();

  const openai = await smokeOpenAIResponses(marker);
  const websocket = await smokeOpenAIWebSocket(marker);
  const anthropic = await smokeAnthropicMessages(marker);
  const admin = skipAdmin
    ? undefined
    : await smokeAdmin([openai, websocket, anthropic], marker);

  for (const result of [openai, websocket, anthropic]) {
    console.log(`${result.surface}_${result.transport}_route=${result.route ?? "admin-verified"} model=${result.model ?? "admin-verified"} session=${result.sessionId}`);
  }
  if (admin) {
    console.log(`admin_persistence=requests:${admin.requestCount} sessions:${admin.sessionCount} prompts:${admin.promptCount}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`deployed smoke failed for ${baseUrl}: ${message}`, { cause: error });
}

async function smokeHealth() {
  const health = await fetchJson(`${baseUrl}/healthz`);
  if (recordString(health, "status") !== "ok") {
    throw new Error(`/healthz returned unexpected body: ${JSON.stringify(health)}`);
  }
}

async function smokeModels() {
  const models = await fetchJson(`${baseUrl}/v1/models`);
  const data = recordArray(models, "data");
  const ids = data.map((item) => recordString(item, "id")).filter(Boolean);
  for (const id of ["router-auto", "claude-router-auto"]) {
    if (!ids.includes(id)) throw new Error(`/v1/models is missing ${id}`);
  }
}

async function smokeOpenAIResponses(parentMarker: string): Promise<SmokeResult> {
  const sessionId = `${parentMarker}-codex-sse`;
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "x-codex-session-id": sessionId,
      "x-request-id": `${sessionId}-request`,
      traceparent: traceparent()
    },
    body: JSON.stringify({
      model: "router-auto",
      input: `${parentMarker} codex sse route smoke. Reply with OK only.`,
      stream: true,
      max_output_tokens: 16
    }),
    signal: AbortSignal.timeout(60000)
  });
  const body = await response.text();
  assertOk(response, body, "OpenAI Responses SSE");
  return {
    surface: "openai-responses",
    transport: "sse",
    sessionId,
    route: requiredHeader(response, "x-proxy-route", "OpenAI Responses SSE"),
    model: requiredHeader(response, "x-proxy-model", "OpenAI Responses SSE")
  };
}

async function smokeOpenAIWebSocket(parentMarker: string): Promise<SmokeResult> {
  const sessionId = `${parentMarker}-codex-ws`;
  const url = new URL(`${baseUrl}/v1/responses`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "openai-beta": "responses_websockets=2026-02-06",
        "x-codex-session-id": sessionId,
        "x-request-id": `${sessionId}-request`,
        traceparent: traceparent()
      }
    });
    let completed = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("OpenAI Responses WebSocket timed out"));
    }, 45000);

    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "response.create",
        model: "router-auto",
        input: `${parentMarker} codex websocket route smoke. Reply with OK only.`,
        max_output_tokens: 64
      }));
    });
    socket.on("message", (data) => {
      const event = parseJson(String(data));
      const eventType = recordString(event, "type");
      if (eventType === "response.completed" || eventType === "response.incomplete") {
        completed = true;
        clearTimeout(timer);
        socket.close();
        resolve();
      }
      if (eventType === "response.failed" || eventType === "error") {
        clearTimeout(timer);
        socket.close();
        reject(new Error(`OpenAI Responses WebSocket returned error: ${JSON.stringify(event)}`));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", (code) => {
      if (!completed) {
        clearTimeout(timer);
        reject(new Error(`OpenAI Responses WebSocket closed before completion with code ${code}`));
      }
    });
  });

  return {
    surface: "openai-responses",
    transport: "websocket",
    sessionId
  };
}

async function smokeAnthropicMessages(parentMarker: string): Promise<SmokeResult> {
  const sessionId = `${parentMarker}-claude-sse`;
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": sessionId,
      "x-request-id": `${sessionId}-request`,
      traceparent: traceparent()
    },
    body: JSON.stringify({
      model: "claude-router-auto",
      messages: [{ role: "user", content: `${parentMarker} claude route smoke. Reply with OK only.` }],
      stream: true,
      max_tokens: 16
    }),
    signal: AbortSignal.timeout(60000)
  });
  const body = await response.text();
  assertOk(response, body, "Anthropic Messages SSE");
  return {
    surface: "anthropic-messages",
    transport: "sse",
    sessionId,
    route: requiredHeader(response, "x-proxy-route", "Anthropic Messages SSE"),
    model: requiredHeader(response, "x-proxy-model", "Anthropic Messages SSE")
  };
}

async function smokeAdmin(results: SmokeResult[], parentMarker: string): Promise<AdminProof> {
  const cookie = adminCookie ?? await loginAdmin();
  const headers = { cookie };
  const viewer = await gqlJson(
    "query { viewer { organizationId } }",
    undefined,
    headers
  );
  if (expectedOrganizationId && recordString(viewer.viewer, "organizationId") !== expectedOrganizationId) {
    throw new Error(`viewer organization mismatch: expected=${expectedOrganizationId} actual=${recordString(viewer.viewer, "organizationId")}`);
  }

  return poll(async () => {
    const overview = await gqlJson(
      `query AdminSmoke($limit: Int) {
        requests { sessionId finalRoute selectedModel }
        sessions { sessionId externalSessionId }
        prompts(limit: $limit) { data { preview } }
      }`,
      { limit: 200 },
      headers
    );
    const requestRows = recordArray(overview, "requests");
    const sessionRows = recordArray(overview, "sessions");
    const promptRows = recordArray(asRecord(overview.prompts), "data");

    for (const result of results) {
      const request = requestRows.find((row) => matchesSessionId(recordString(row, "sessionId"), result.sessionId));
      if (!request) throw new Error(`admin requests missing session ${result.sessionId}`);
      if (!recordString(request, "finalRoute")) throw new Error(`admin request missing finalRoute for ${result.sessionId}`);
      if (!recordString(request, "selectedModel")) throw new Error(`admin request missing selectedModel for ${result.sessionId}`);
      const session = sessionRows.find((row) =>
        matchesSessionId(recordString(row, "sessionId"), result.sessionId) ||
        matchesSessionId(recordString(row, "externalSessionId"), result.sessionId)
      );
      if (!session) {
        throw new Error(`admin sessions missing ${result.sessionId}`);
      }

      const sessionDetailId = recordString(session, "sessionId") ?? result.sessionId;
      const detailResult = await gqlJson(
        `query SmokeSessionDetail($sessionId: ID!) {
          session(sessionId: $sessionId) {
            requests { requestId }
            routeDecisions { id }
            providerAttempts { id }
            usageLedger { id }
            promptArtifacts { artifactId }
          }
        }`,
        { sessionId: sessionDetailId },
        headers
      );
      const detail = asRecord(detailResult.session);
      if (recordArray(detail, "requests").length === 0) throw new Error(`session detail missing requests for ${result.sessionId}`);
      if (recordArray(detail, "routeDecisions").length === 0) throw new Error(`session detail missing route decisions for ${result.sessionId}`);
      if (recordArray(detail, "providerAttempts").length === 0) throw new Error(`session detail missing provider attempts for ${result.sessionId}`);
      if (recordArray(detail, "usageLedger").length === 0) throw new Error(`session detail missing usage ledger for ${result.sessionId}`);
      if (recordArray(detail, "promptArtifacts").length === 0) throw new Error(`session detail missing prompt artifacts for ${result.sessionId}`);
    }

    if (!promptRows.some((row) => recordString(row, "preview")?.includes(parentMarker))) {
      throw new Error(`admin prompts missing marker ${parentMarker}`);
    }

    return {
      requestCount: requestRows.length,
      sessionCount: sessionRows.length,
      promptCount: promptRows.length
    };
  }, 30000);
}

async function gqlJson(
  query: string,
  variables: Record<string, unknown> | undefined,
  headers: Record<string, string>
) {
  const body = await fetchJson(`${baseUrl}/admin/graphql`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(variables ? { query, variables } : { query })
  });
  const errors = recordArray(body, "errors");
  if (errors.length > 0) {
    throw new Error(`admin graphql error: ${JSON.stringify(errors[0])}`);
  }
  const data = asRecord(asRecord(body).data);
  if (Object.keys(data).length === 0) throw new Error("admin graphql returned no data");
  return data;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function loginAdmin() {
  if (!adminEmail || !adminPassword) {
    throw new Error("admin smoke requires PROXY_DEPLOYED_ADMIN_COOKIE or PROXY_DEPLOYED_ADMIN_EMAIL/PROXY_DEPLOYED_ADMIN_PASSWORD. Set PROXY_DEPLOYED_SKIP_ADMIN=true to skip persistence checks.");
  }
  const response = await fetch(`${baseUrl}/admin/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { organizationId } }",
      variables: { email: adminEmail, password: adminPassword }
    }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.text();
  assertOk(response, body, "admin login");
  const errors = recordArray(parseJson(body), "errors");
  if (errors.length > 0) throw new Error(`admin login failed: ${JSON.stringify(errors[0])}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("admin login did not return a session cookie");
  return cookie;
}

function matchesSessionId(actual: string | undefined, expected: string) {
  return actual === expected || actual?.endsWith(`:${expected}`) === true;
}

async function fetchJson(url: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.text();
  assertOk(response, body, url);
  return parseJson(body);
}

async function poll<T>(fn: () => Promise<T>, timeoutMs: number) {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function assertOk(response: Response, body: string, label: string) {
  if (!response.ok) {
    throw new Error(`${label} returned ${response.status}: ${body.slice(0, 2000)}`);
  }
}

function requiredHeader(response: Response, name: string, label: string) {
  const value = response.headers.get(name);
  if (!value) throw new Error(`${label} response missing ${name}`);
  return value;
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function requiredEnv(keys: string[]) {
  const value = optionalEnv(keys);
  if (!value) throw new Error(`Missing required env: ${keys.join(" or ")}`);
  return value;
}

function optionalEnv(keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function booleanEnv(value: string | undefined) {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Expected JSON, received: ${value.slice(0, 500)}`);
  }
}

function recordArray(value: unknown, key: string) {
  if (!isRecord(value)) return [];
  const raw = value[key];
  return Array.isArray(raw) ? raw : [];
}

function recordString(value: unknown, key: string) {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function traceparent() {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function randomHex(bytes: number) {
  return randomBytes(bytes).toString("hex");
}
