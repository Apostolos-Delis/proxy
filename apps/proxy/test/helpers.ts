import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import { WebSocketServer } from "ws";

import type { buildServer } from "../src/server.js";

export type RecordedRequest = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
};

export type MockServer = {
  url: string;
  records: RecordedRequest[];
  providerClosed?: Promise<void>;
  close: () => Promise<void>;
};

type RateLimitMock = {
  headers?: Record<string, string>;
  body?: unknown;
};

export async function startOpenAIMock(
  options: {
    invalidClassifier?: boolean;
    classifierOutput?: Record<string, unknown>;
    classifierOutputs?: Record<string, unknown>[];
    classifierUsage?: Record<string, unknown>;
    classifierResponsesShape?: boolean;
    compressedJsonProvider?: boolean;
    failProviderOnce?: boolean;
    rateLimitProviderOnce?: RateLimitMock;
    slowProvider?: boolean;
    streamContentType?: string;
    wsTerminalEvent?: "response.completed" | "response.incomplete";
    wsUpgradeHeaders?: Record<string, string>;
    outputText?: string;
    redirectProviderTo?: string;
  } = {}
): Promise<MockServer> {
  const records: RecordedRequest[] = [];
  const classifierOutputs = [...(options.classifierOutputs ?? [])];
  const wss = new WebSocketServer({ noServer: true });
  let wsResponseCount = 0;
  let providerFailed = false;
  let providerRateLimited = false;
  let resolveProviderClosed: (() => void) | undefined;
  const providerClosed = new Promise<void>((resolve) => {
    resolveProviderClosed = resolve;
  });
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", headers: request.headers, body });

    if (body.model === "route-classifier-cheap" || isClassifierRequest(body)) {
      const classifierOutput = classifierOutputs.shift() ?? options.classifierOutput;
      const outputText = options.invalidClassifier
        ? JSON.stringify({ nope: true })
        : JSON.stringify(
            classifierOutput ?? {
              complexity: "hard",
              risk: ["auth", "failing_test"],
              recommended_route: "hard",
              can_use_fast_model: false,
              needs_deep_reasoning: false,
              reason_codes: ["auth_risk", "failing_test", "tools_present"],
              confidence: 0.82
            }
          );
      if (options.classifierResponsesShape) {
        sendJson(response, {
          output: [
            { id: "rs_mock", type: "reasoning", content: [], summary: [] },
            {
              id: "msg_mock",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", annotations: [], logprobs: [], text: outputText }]
            }
          ],
          ...(options.classifierUsage ? { usage: options.classifierUsage } : {})
        });
        return;
      }
      sendJson(response, {
        output_text: outputText,
        ...(options.classifierUsage ? { usage: options.classifierUsage } : {})
      });
      return;
    }

    if (options.rateLimitProviderOnce && !providerRateLimited) {
      providerRateLimited = true;
      response.writeHead(429, {
        "content-type": "application/json",
        ...options.rateLimitProviderOnce.headers
      });
      response.end(JSON.stringify(
        options.rateLimitProviderOnce.body ?? { error: { message: "mock rate limit", code: "rate_limit" } }
      ));
      return;
    }

    if (options.failProviderOnce && !providerFailed) {
      providerFailed = true;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "mock provider unavailable" } }));
      return;
    }

    if (options.redirectProviderTo) {
      response.writeHead(302, { location: `${options.redirectProviderTo}/responses` });
      response.end();
      return;
    }

    if (options.compressedJsonProvider) {
      const payload = JSON.stringify({
        id: "resp_mock",
        status: "completed",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 }
        }
      });
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip"
      });
      response.end(gzipSync(payload));
      return;
    }

    if (request.url === "/chat/completions") {
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 120
      };
      if (!body.stream) {
        sendJson(response, {
          id: "chatcmpl_mock",
          choices: [{ message: { role: "assistant", content: options.outputText ?? "chat mock" } }],
          usage
        });
        return;
      }
      response.writeHead(200, { "content-type": options.streamContentType ?? "text/event-stream" });
      response.on("close", () => resolveProviderClosed?.());
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl_mock",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: options.outputText ?? "chat mock" }, finish_reason: null }],
          usage: null
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl_mock",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: null
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl_mock",
          object: "chat.completion.chunk",
          choices: [],
          usage
        })}\n\n`
      );
      response.write("data: [DONE]\n\n");
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": options.streamContentType ?? "text/event-stream" });
    response.on("close", () => resolveProviderClosed?.());
    response.write(
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_mock" } })}\n\n`
    );
    if (options.slowProvider) return;
    if (options.outputText) {
      response.write(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: options.outputText })}\n\n`
      );
    }
    response.write(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_mock",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 5 }
          }
        }
      })}\n\n`
    );
    response.end();
  });

  if (options.wsUpgradeHeaders) {
    wss.on("headers", (headers) => {
      for (const [key, value] of Object.entries(options.wsUpgradeHeaders ?? {})) {
        headers.push(`${key}: ${value}`);
      }
    });
  }

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/responses") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      client.on("message", (data) => {
        const body = JSON.parse(String(data));
        records.push({ path: request.url ?? "", headers: request.headers, body });
        wsResponseCount += 1;
        const id = `resp_ws_${wsResponseCount}`;
        client.send(JSON.stringify({
          type: "response.created",
          response: { id, model: body.model }
        }));
        client.send(JSON.stringify({
          type: options.wsTerminalEvent ?? "response.completed",
          response: {
            id,
            model: body.model,
            status: options.wsTerminalEvent === "response.incomplete" ? "incomplete" : "completed",
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              output_tokens_details: { reasoning_tokens: 5 }
            }
          }
        }));
      });
    });
  });

  return { ...(await listenMock(server, records)), providerClosed };
}

function isClassifierRequest(body: Record<string, unknown>) {
  const text = body.text;
  if (!text || typeof text !== "object" || Array.isArray(text)) return false;
  const format = (text as Record<string, unknown>).format;
  if (!format || typeof format !== "object" || Array.isArray(format)) return false;
  const schema = (format as Record<string, unknown>).schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const properties = (schema as Record<string, unknown>).properties;
  return (format as Record<string, unknown>).type === "json_schema" &&
    Boolean(
      properties &&
      typeof properties === "object" &&
      !Array.isArray(properties) &&
      "recommended_route" in properties
    );
}

export async function startAnthropicMock(options: {
  outputText?: string;
  rateLimitProviderOnce?: RateLimitMock;
} = {}): Promise<MockServer> {
  const records: RecordedRequest[] = [];
  let providerRateLimited = false;
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", headers: request.headers, body });

    if (request.url === "/messages/count_tokens") {
      sendJson(response, { input_tokens: 42 });
      return;
    }

    if (options.rateLimitProviderOnce && !providerRateLimited) {
      providerRateLimited = true;
      response.writeHead(429, {
        "content-type": "application/json",
        ...options.rateLimitProviderOnce.headers
      });
      response.end(JSON.stringify(
        options.rateLimitProviderOnce.body ?? { error: { message: "mock rate limit", type: "rate_limit_error" } }
      ));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_mock", usage: { input_tokens: 120, output_tokens: 0 } }
      })}\n\n`
    );
    if (options.outputText) {
      response.write(
        `data: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: options.outputText }
        })}\n\n`
      );
    }
    response.write(
      `data: ${JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 30 }
      })}\n\n`
    );
    response.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    response.end();
  });

  return listenMock(server, records);
}

export function listen(app: ReturnType<typeof buildServer>) {
  return app.listen({ port: 0, host: "127.0.0.1" }).then(() => {
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  });
}

function listenMock(server: ReturnType<typeof createServer>, records: RecordedRequest[]) {
  return new Promise<MockServer>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        records,
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
    request.on("end", () => {
      resolve(body ? JSON.parse(body) : {});
    });
  });
}

function sendJson(response: ServerResponse, body: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
