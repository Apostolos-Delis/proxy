import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { join } from "node:path";

import { WebSocketServer } from "ws";

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
    LOG_LEVEL: "fatal"
  });
const app = buildServer(config);

try {
  const proxyUrl = await app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  });

  await runCodex(proxyUrl);
  await runClaude(proxyUrl);

  if (!openaiRecords.some((record) => record.body.model === "gpt-5.5")) {
    throw new Error("Codex CLI did not route to OpenAI hard model.");
  }
  if (!anthropicRecords.some((record) => record.body.model === config.anthropicHardModel)) {
    throw new Error("Claude Code CLI did not route to Anthropic hard model.");
  }

  console.log("codex_cli_route=hard model=gpt-5.5");
  console.log(`claude_cli_route=hard model=${config.anthropicHardModel}`);
} finally {
  await app.close();
  await openai.close();
  await anthropic.close();
}

async function runCodex(proxyUrl: string) {
  const codexHome = await mkdtemp(join(tmpdir(), "prompt-proxy-codex-"));
  const workdir = await mkdtemp(join(tmpdir(), "prompt-proxy-workdir-"));
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model = "router-auto"',
      'model_provider = "prompt_proxy"',
      "",
      "[model_providers.prompt_proxy]",
      'name = "Prompt Proxy"',
      `base_url = "${proxyUrl}/v1"`,
      'env_key = "PROMPT_PROXY_TOKEN"',
      'wire_api = "responses"',
      "supports_websockets = true",
      ""
    ].join("\n")
  );

  await runCommand("codex", [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--cd",
    workdir,
    "Reply with the exact text OK. Do not call tools."
  ], {
    CODEX_HOME: codexHome,
    PROMPT_PROXY_TOKEN: "proxy-token"
  });
}

async function runClaude(proxyUrl: string) {
  await runCommand("claude", [
    "-p",
    "--bare",
    "--model",
    "claude-router-auto",
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "Reply with the exact text OK. Do not call tools."
  ], {
    ANTHROPIC_BASE_URL: proxyUrl,
    ANTHROPIC_API_KEY: "proxy-token",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
  });
}

function runCommand(command: string, args: string[], env: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function mockOpenAI(records: Recorded[]) {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", body });

    if (body.model === "route-classifier-cheap") {
      sendJson(response, {
        output_text: JSON.stringify({
          complexity: "hard",
          risk: ["auth"],
          recommended_route: "hard",
          can_use_fast_model: false,
          needs_deep_reasoning: false,
          reason_codes: ["auth_risk"],
          confidence: 0.9
        })
      });
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(response, {
      type: "response.created",
      response: { id: "resp_cli_smoke" }
    });
    writeSse(response, {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "msg_cli_smoke",
        content: [{ type: "output_text", text: "OK" }]
      }
    });
    writeSse(response, {
      type: "response.completed",
      response: {
        id: "resp_cli_smoke",
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 11
        }
      }
    });
    response.end();
  });

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/responses") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data) => {
        const body = JSON.parse(String(data));
        records.push({ path: request.url ?? "", body });
        client.send(JSON.stringify({
          type: "response.created",
          response: { id: "resp_cli_smoke" }
        }));
        client.send(JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "assistant",
            id: "msg_cli_smoke",
            content: [{ type: "output_text", text: "OK" }]
          }
        }));
        client.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_cli_smoke",
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 1,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 11
            }
          }
        }));
      });
    });
  });

  return listen(server);
}

async function mockAnthropic(records: Recorded[]) {
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", body });

    if (request.url === "/messages/count_tokens") {
      sendJson(response, { input_tokens: 10 });
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    writeSse(response, {
      type: "message_start",
      message: {
        id: "msg_cli_smoke",
        type: "message",
        role: "assistant",
        content: [],
        model: body.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 }
      }
    });
    writeSse(response, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    });
    writeSse(response, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "OK" }
    });
    writeSse(response, {
      type: "content_block_stop",
      index: 0
    });
    writeSse(response, {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 }
    });
    writeSse(response, { type: "message_stop" });
    response.end();
  });

  return listen(server);
}

function writeSse(response: { write: (chunk: string) => void }, event: Record<string, unknown>) {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
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

function sendJson(response: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, body: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
