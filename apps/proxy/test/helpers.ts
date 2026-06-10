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

export async function startOpenAIMock(
  options: {
    invalidClassifier?: boolean;
    classifierOutput?: Record<string, unknown>;
    classifierOutputs?: Record<string, unknown>[];
    classifierResponsesShape?: boolean;
    compressedJsonProvider?: boolean;
    failProviderOnce?: boolean;
    slowProvider?: boolean;
    wsTerminalEvent?: "response.completed" | "response.incomplete";
    outputText?: string;
  } = {}
): Promise<MockServer> {
  const records: RecordedRequest[] = [];
  const classifierOutputs = [...(options.classifierOutputs ?? [])];
  const wss = new WebSocketServer({ noServer: true });
  let wsResponseCount = 0;
  let providerFailed = false;
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
          ]
        });
        return;
      }
      sendJson(response, { output_text: outputText });
      return;
    }

    if (options.failProviderOnce && !providerFailed) {
      providerFailed = true;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "mock provider unavailable" } }));
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

    response.writeHead(200, { "content-type": "text/event-stream" });
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

export type AnthropicScriptedResponse =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "hang" };

export async function startAnthropicMock(
  options: { outputText?: string; scriptedResponses?: AnthropicScriptedResponse[] } = {}
): Promise<MockServer> {
  const records: RecordedRequest[] = [];
  const scripted = [...(options.scriptedResponses ?? [])];
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", headers: request.headers, body });

    if (request.url === "/messages/count_tokens") {
      sendJson(response, { input_tokens: 42 });
      return;
    }

    if (options.scriptedResponses) {
      const next = scripted.shift();
      if (!next) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "anthropic mock script exhausted" }));
        return;
      }
      sendScriptedAnthropicResponse(response, next);
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

function sendScriptedAnthropicResponse(
  response: ServerResponse,
  scripted: AnthropicScriptedResponse
) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: Record<string, unknown>) => {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  send({
    type: "message_start",
    message: {
      id: "msg_scripted",
      type: "message",
      role: "assistant",
      model: "claude-mock",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 0 }
    }
  });
  if (scripted.type === "hang") return;
  if (scripted.type === "text") {
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: scripted.text }
    });
    send({ type: "content_block_stop", index: 0 });
    send({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 30 }
    });
  } else {
    send({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${scripted.name}`, name: scripted.name, input: {} }
    });
    send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(scripted.input) }
    });
    send({ type: "content_block_stop", index: 0 });
    send({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 30 }
    });
  }
  send({ type: "message_stop" });
  response.end();
}

export function listen(app: ReturnType<typeof buildServer>, port = 0) {
  return app.listen({ port, host: "127.0.0.1" }).then(() => {
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
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
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
