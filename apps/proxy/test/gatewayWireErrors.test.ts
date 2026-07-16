import { afterEach, describe, expect, it } from "vitest";

import { assignHarnessGatewayTarget } from "./gatewayHarnessFixture.js";
import { gatewayHeaders, logicalTarget, postJson } from "./gatewayRuntimeTestHelpers.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("gateway API wire errors", () => {
  const fixtures: PromptTestFixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  });

  it.each([
    [400, "invalid_request_error", "unknown_terminal"],
    [429, "rate_limit_error", "rate_limited"],
    [503, "server_error", "provider_unavailable"]
  ] as const)("renders Anthropic %s failures as OpenAI errors", async (status, type, code) => {
    const fixture = await captureFixture(`org_anthropic_to_openai_${status}`, "hash_only", false, {
      anthropicOptions: { failProviderModels: { "claude-fable-5": status } }
    });
    fixtures.push(fixture);

    const response = await postJson(
      `${fixture.proxyUrl}/v1/responses`,
      gatewayHeaders("proxy-token"),
      { model: "fable", input: `Trigger ${status}` }
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "mock anthropic provider unavailable",
        type,
        code
      }
    });
  });

  it.each([
    [400, "invalid_request_error"],
    [429, "rate_limit_error"],
    [503, "api_error"]
  ] as const)("renders OpenAI %s failures as Anthropic errors", async (status, type) => {
    const organizationId = `org_openai_to_anthropic_${status}`;
    const model = `gpt-wire-errors-${status}`;
    const fixture = await captureFixture(organizationId, "hash_only", false, {
      openAIOptions: { failProviderModels: { [model]: status } }
    });
    fixtures.push(fixture);
    await assignOpenAITarget(fixture, organizationId, model, "wire-errors-token");

    const response = await postJson(
      `${fixture.proxyUrl}/v1/messages`,
      gatewayHeaders("wire-errors-token"),
      {
        model: "fable",
        max_tokens: 64,
        messages: [{ role: "user", content: `Trigger ${status}` }]
      }
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: {
        type,
        message: "mock provider model unavailable"
      }
    });
  });

  it("rejects malformed translated success responses in the ingress wire", async () => {
    const anthropic = await captureFixture("org_malformed_anthropic_response", "hash_only", false, {
      anthropicOptions: { malformedJsonProvider: true }
    });
    fixtures.push(anthropic);
    const openAIResponse = await postJson(
      `${anthropic.proxyUrl}/v1/responses`,
      gatewayHeaders("proxy-token"),
      { model: "fable", input: "Malformed Anthropic response" }
    );
    expect(openAIResponse.status).toBe(502);
    await expect(openAIResponse.json()).resolves.toEqual({
      error: {
        message: "Provider returned a malformed response.",
        type: "server_error",
        code: "malformed_upstream_response"
      }
    });

    const openAI = await captureFixture("org_malformed_openai_response", "hash_only", false, {
      openAIOptions: { malformedJsonProvider: true }
    });
    fixtures.push(openAI);
    await assignOpenAITarget(openAI, "org_malformed_openai_response", "gpt-malformed", "malformed-token");
    const anthropicResponse = await postJson(
      `${openAI.proxyUrl}/v1/messages`,
      gatewayHeaders("malformed-token"),
      {
        model: "fable",
        max_tokens: 64,
        messages: [{ role: "user", content: "Malformed OpenAI response" }]
      }
    );
    expect(anthropicResponse.status).toBe(502);
    await expect(anthropicResponse.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Provider returned a malformed response."
      }
    });
  });

  it.each([
    {
      name: "OpenAI Responses",
      path: "/v1/responses",
      body: { model: "fable", input: "Authenticate" },
      expected: {
        error: { message: "Unauthorized", type: "authentication_error", code: "unauthorized" }
      }
    },
    {
      name: "Anthropic Messages",
      path: "/v1/messages",
      body: { model: "fable", messages: [{ role: "user", content: "Authenticate" }], max_tokens: 16 },
      expected: {
        type: "error",
        error: { type: "authentication_error", message: "Unauthorized" }
      }
    }
  ])("renders authentication failures in the $name wire", async ({ path, body, expected }) => {
    const fixture = await captureFixture(`org_auth_wire_${path.replaceAll("/", "_")}`, "hash_only");
    fixtures.push(fixture);

    const response = await postJson(`${fixture.proxyUrl}${path}`, gatewayHeaders("invalid-token"), body);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(expected);
  });

  it.each([
    {
      name: "OpenAI Responses",
      path: "/v1/responses",
      body: { model: "fable", input: "X".repeat(1_000) },
      expected: {
        error: {
          message: "Request body exceeds gateway limit.",
          type: "invalid_request_error",
          code: "request_body_too_large"
        },
        limitBytes: 256
      }
    },
    {
      name: "Anthropic Messages",
      path: "/v1/messages",
      body: {
        model: "fable",
        messages: [{ role: "user", content: "X".repeat(1_000) }],
        max_tokens: 16
      },
      expected: {
        type: "error",
        error: { type: "invalid_request_error", message: "Request body exceeds gateway limit." },
        limitBytes: 256
      }
    }
  ])("renders body-limit failures in the $name wire", async ({ path, body, expected }) => {
    const fixture = await captureFixture(`org_body_wire_${path.replaceAll("/", "_")}`, "hash_only", false, {
      envOverrides: { REQUEST_BODY_LIMIT_BYTES: "256" }
    });
    fixtures.push(fixture);

    const response = await postJson(`${fixture.proxyUrl}${path}`, gatewayHeaders("proxy-token"), body);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual(expected);
  });

  it.each(["openai", "anthropic"] as const)(
    "renders duplicate admission in the %s ingress wire",
    async (wire) => {
      const classifierOutput: Record<string, unknown> = {
        target_id: "pending",
        reason_codes: ["capability_match"],
        confidence: 0.9
      };
      const fixture = await captureFixture(`org_duplicate_wire_${wire}`, "hash_only", false, {
        openAIOptions: wire === "openai"
          ? { slowProvider: true, classifierOutput, classifierResponsesShape: true }
          : undefined,
        anthropicOptions: wire === "anthropic" ? { slowProvider: true } : undefined
      });
      fixtures.push(fixture);
      if (wire === "openai") {
        const target = await logicalTarget(fixture, "coding-auto", "openai");
        classifierOutput.target_id = target.targetId;
      }
      const path = wire === "openai" ? "/v1/responses" : "/v1/messages";
      const body = wire === "openai"
        ? { model: "coding-auto", input: "Hold this request", stream: true }
        : {
            model: "fable",
            messages: [{ role: "user", content: "Hold this request" }],
            max_tokens: 16,
            stream: true
          };
      const controller = new AbortController();
      const first = await fetch(`${fixture.proxyUrl}${path}`, {
        method: "POST",
        headers: gatewayHeaders("proxy-token"),
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const duplicate = await postJson(`${fixture.proxyUrl}${path}`, gatewayHeaders("proxy-token"), body);
      controller.abort();
      await first.text().catch(() => "");

      expect(duplicate.status).toBe(409);
      const expected = wire === "openai"
        ? {
            error: {
              message: "Duplicate request is still active.",
              type: "invalid_request_error",
              code: "duplicate_request_active"
            },
            status: "provider_pending"
          }
        : {
            type: "error",
            error: { type: "invalid_request_error", message: "Duplicate request is still active." },
            status: "provider_pending"
          };
      await expect(duplicate.json()).resolves.toEqual(expected);
    }
  );

  it.each(["openai", "anthropic"] as const)(
    "renders request rate limits in the %s ingress wire",
    async (wire) => {
      const fixture = await captureFixture(`org_rate_wire_${wire}`, "hash_only", false, {
        envOverrides: { GATEWAY_API_KEY_RPM_LIMIT: "1" }
      });
      fixtures.push(fixture);
      const path = wire === "openai" ? "/v1/responses" : "/v1/messages";
      const body = wire === "openai"
        ? { model: "fable", input: "Rate limit this request" }
        : { model: "fable", messages: [{ role: "user", content: "Rate limit this request" }], max_tokens: 16 };
      const first = await postJson(`${fixture.proxyUrl}${path}`, gatewayHeaders("proxy-token"), body);
      await first.text();

      const limited = await postJson(`${fixture.proxyUrl}${path}`, gatewayHeaders("proxy-token"), body);

      expect(first.status).toBe(200);
      expect(limited.status).toBe(429);
      expectRetryAfter(limited);
      const expected = wire === "openai"
        ? {
            error: {
              message: "traffic_limit_exceeded:api_key:rpm",
              type: "rate_limit_error",
              code: "traffic_limit_exceeded:api_key:rpm"
            },
            scope: "api_key",
            limit: 1,
            current: 1
          }
        : {
            type: "error",
            error: { type: "rate_limit_error", message: "traffic_limit_exceeded:api_key:rpm" },
            scope: "api_key",
            limit: 1,
            current: 1
          };
      await expect(limited.json()).resolves.toEqual(expected);
    }
  );
});

function expectRetryAfter(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  expect(seconds).toBeGreaterThan(0);
  expect(seconds).toBeLessThanOrEqual(60);
}

async function assignOpenAITarget(
  fixture: PromptTestFixture,
  organizationId: string,
  model: string,
  secret: string
) {
  await assignHarnessGatewayTarget(fixture, organizationId, {
    secret,
    slug: model,
    provider: "openai",
    connectionSlug: "openai",
    model,
    config: {},
    wires: [{ dialect: "openai-responses", path: "/responses" }]
  });
}
