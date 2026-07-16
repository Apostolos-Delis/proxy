import { afterEach, describe, expect, it } from "vitest";

import { assignHarnessGatewayTarget } from "./gatewayHarnessFixture.js";
import { gatewayHeaders, postJson } from "./gatewayRuntimeTestHelpers.js";
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
});

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
