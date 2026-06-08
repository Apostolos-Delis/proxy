import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

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
    slowProvider?: boolean;
  } = {}
): Promise<MockServer> {
  const records: RecordedRequest[] = [];
  const classifierOutputs = [...(options.classifierOutputs ?? [])];
  let resolveProviderClosed: (() => void) | undefined;
  const providerClosed = new Promise<void>((resolve) => {
    resolveProviderClosed = resolve;
  });
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", headers: request.headers, body });

    if (body.model === "route-classifier-cheap") {
      const classifierOutput = classifierOutputs.shift() ?? options.classifierOutput;
      sendJson(response, {
        output_text: options.invalidClassifier
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
            )
      });
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.on("close", () => resolveProviderClosed?.());
    response.write(
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_mock" } })}\n\n`
    );
    if (options.slowProvider) return;
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

  return { ...(await listenMock(server, records)), providerClosed };
}

export async function startAnthropicMock(): Promise<MockServer> {
  const records: RecordedRequest[] = [];
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    records.push({ path: request.url ?? "", headers: request.headers, body });

    if (request.url === "/messages/count_tokens") {
      sendJson(response, { input_tokens: 42 });
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_mock", usage: { input_tokens: 120, output_tokens: 0 } }
      })}\n\n`
    );
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
