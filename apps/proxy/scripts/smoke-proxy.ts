import { createServer, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

type Recorded = {
  path: string;
  body: any;
};

const openaiRecords: Recorded[] = [];
const anthropicRecords: Recorded[] = [];

const openai = await mockOpenAI(openaiRecords);
const anthropic = await mockAnthropic(anthropicRecords);
const config = loadConfig({
    ...process.env,
    PROMPT_PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    OPENAI_BASE_URL: openai.url,
    ANTHROPIC_BASE_URL: anthropic.url,
    CLASSIFIER_PROVIDER: "openai",
    CLASSIFIER_MODEL: "route-classifier-cheap",
    LOG_LEVEL: "error"
  });
const app = buildServer(config);

try {
  const proxyUrl = await app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  });

  const codex = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json",
      "x-codex-turn-state": "smoke-codex-turn"
    },
    body: JSON.stringify({
      model: "router-auto",
      input: "fix the failing auth test and find root cause",
      tools: [{ type: "function", name: "shell" }],
      stream: true
    })
  });
  await codex.text();

  const claude = await fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer proxy-token",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": "smoke-claude-session"
    },
    body: JSON.stringify({
      model: "claude-router-auto",
      messages: [{ role: "user", content: "debug this flaky auth regression" }],
      tools: [{ name: "bash", input_schema: { type: "object" } }],
      stream: true,
      max_tokens: 2048
    })
  });
  await claude.text();

  const codexProviderCall = openaiRecords.find((record) => record.body.model === "gpt-5.5");
  const claudeProviderCall = anthropicRecords.find(
    (record) => record.body.model === config.anthropicHardModel
  );

  if (!codex.ok || !codexProviderCall) {
    throw new Error("Codex/OpenAI Responses smoke failed.");
  }
  if (!claude.ok || !claudeProviderCall) {
    throw new Error("Claude Code/Anthropic Messages smoke failed.");
  }

  console.log("codex_route=hard model=gpt-5.5");
  console.log(`claude_route=hard model=${config.anthropicHardModel}`);
} finally {
  await app.close();
  await openai.close();
  await anthropic.close();
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
