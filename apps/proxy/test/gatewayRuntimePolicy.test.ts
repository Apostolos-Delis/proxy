import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { logicalModelTargets, modelDeployments, usageLedger } from "@proxy/db";

import {
  gatewayHeaders,
  logicalTarget,
  postJson
} from "./gatewayRuntimeTestHelpers.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("logical-model gateway policy", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
  });

  it("enforces organization and pinned session system prompts across OpenAI and Anthropic", async () => {
    const organizationId = "org_gateway_runtime_system_prompt";
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["capability_match"],
      confidence: 0.94
    };
    fixture = await captureFixture(organizationId, "hash_only", false, {
      openAIOptions: { classifierOutput, classifierResponsesShape: true },
      anthropicOptions: { outputText: "policy applied" }
    });
    const target = await logicalTarget(fixture, "coding-auto", "openai");
    classifierOutput.target_id = target.targetId;
    await fixture.persistence.organizationSettings.setSystemPrompt(
      organizationId,
      "Initial organization policy."
    );

    const sendOpenAI = (input: string) => postJson(
      `${fixture!.proxyUrl}/v1/responses`,
      {
        ...gatewayHeaders("proxy-token"),
        "x-codex-session-id": "gateway-system-prompt-session"
      },
      {
        model: "coding-auto",
        instructions: "You are Codex.",
        input
      }
    );
    const first = await sendOpenAI("Apply the first policy");
    expect(first.status).toBe(200);
    await first.text();
    await fixture.persistence.organizationSettings.setSystemPrompt(
      organizationId,
      "Updated organization policy."
    );
    const second = await sendOpenAI("Keep the pinned policy");
    expect(second.status).toBe(200);
    await second.text();

    const messages = await postJson(`${fixture.proxyUrl}/v1/messages`, gatewayHeaders("proxy-token"), {
      model: "fable",
      system: [{ type: "text", text: "You are Claude Code." }],
      messages: [{ role: "user", content: "Apply the current policy" }],
      max_tokens: 128
    });
    expect(messages.status).toBe(200);
    await messages.text();
    const count = await postJson(
      `${fixture.proxyUrl}/v1/messages/count_tokens`,
      gatewayHeaders("proxy-token"),
      {
        model: "fable",
        system: "You are Claude Code.",
        messages: [{ role: "user", content: "Count with the current policy" }]
      }
    );
    expect(count.status).toBe(200);
    await count.text();

    const openAICalls = fixture.openai.records.filter((record) => (
      record.path === "/responses" && record.body.model === target.upstreamModelId
    ));
    expect(openAICalls.map((record) => record.body.instructions)).toEqual([
      "Initial organization policy.\n\nYou are Codex.",
      "Initial organization policy.\n\nYou are Codex."
    ]);
    const anthropicCall = fixture.anthropic.records.find((record) => record.path === "/messages");
    expect(anthropicCall?.body.system).toEqual([
      { type: "text", text: "Updated organization policy." },
      { type: "text", text: "You are Claude Code." }
    ]);
    const countCall = fixture.anthropic.records.find((record) => record.path === "/messages/count_tokens");
    expect(countCall?.body.system).toBe(
      "Updated organization policy.\n\nYou are Claude Code."
    );
  });

  it("rejects a direct target when the injected system prompt exceeds its context window", async () => {
    const organizationId = "org_gateway_runtime_direct_prompt_capacity";
    fixture = await captureFixture(organizationId, "hash_only");
    const target = await logicalTarget(fixture, "fable", "anthropic");
    await fixture.db
      .update(modelDeployments)
      .set({ capabilities: { contextWindow: 100 } })
      .where(eq(modelDeployments.id, target.deploymentId));
    await fixture.persistence.organizationSettings.setSystemPrompt(
      organizationId,
      "P".repeat(400)
    );

    const response = await postJson(`${fixture.proxyUrl}/v1/messages`, gatewayHeaders("proxy-token"), {
      model: "fable",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "context_overflow" }
    });
    expect(fixture.anthropic.records).toHaveLength(0);
  });

  it("excludes routed targets that only overflow after policy injection", async () => {
    const organizationId = "org_gateway_runtime_router_prompt_capacity";
    fixture = await captureFixture(organizationId, "hash_only", false, {
      anthropicOptions: { outputText: "large target selected" }
    });
    const small = await logicalTarget(fixture, "coding-auto", "openai");
    const large = await logicalTarget(fixture, "coding-auto", "anthropic");
    await fixture.db
      .update(modelDeployments)
      .set({ capabilities: { contextWindow: 100 } })
      .where(eq(modelDeployments.id, small.deploymentId));
    await fixture.db
      .update(modelDeployments)
      .set({ capabilities: { contextWindow: 10_000 } })
      .where(eq(modelDeployments.id, large.deploymentId));
    await fixture.db
      .update(logicalModelTargets)
      .set({ priority: 0 })
      .where(eq(logicalModelTargets.id, small.targetId));
    await fixture.db
      .update(logicalModelTargets)
      .set({ priority: 1 })
      .where(eq(logicalModelTargets.id, large.targetId));
    await fixture.persistence.organizationSettings.setSystemPrompt(
      organizationId,
      "P".repeat(400)
    );

    const response = await postJson(`${fixture.proxyUrl}/v1/responses`, gatewayHeaders("proxy-token"), {
      model: "coding-auto",
      input: "Hi",
      max_output_tokens: 1
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(fixture.openai.records.some((record) => record.body.model === small.upstreamModelId))
      .toBe(false);
    expect(fixture.anthropic.records.some((record) => record.body.model === large.upstreamModelId))
      .toBe(true);
  });

  it("applies organization prompt-cache settings to generation but not token counting", async () => {
    const organizationId = "org_gateway_runtime_prompt_cache";
    fixture = await captureFixture(organizationId, "hash_only", false, {
      anthropicOptions: { outputText: "cached answer" }
    });
    await fixture.persistence.organizationSettings.setAutomaticCaching(organizationId, true);
    await fixture.persistence.organizationSettings.setCacheTtlUpgrade(organizationId, true);
    const conversation = [
      { role: "user", content: "A".repeat(9_000) },
      { role: "assistant", content: "Prior answer" },
      { role: "user", content: "Continue" }
    ];

    const generation = await postJson(`${fixture.proxyUrl}/v1/messages`, gatewayHeaders("proxy-token"), {
      model: "fable",
      messages: conversation,
      max_tokens: 128
    });
    expect(generation.status).toBe(200);
    await generation.text();
    const count = await postJson(
      `${fixture.proxyUrl}/v1/messages/count_tokens`,
      gatewayHeaders("proxy-token"),
      { model: "fable", messages: conversation }
    );
    expect(count.status).toBe(200);
    await count.text();

    expect(fixture.anthropic.records.find((record) => record.path === "/messages")?.body.cache_control)
      .toEqual({ type: "ephemeral", ttl: "1h" });
    expect(fixture.anthropic.records.find((record) => record.path === "/messages/count_tokens")?.body)
      .not.toHaveProperty("cache_control");
  });

  it("compresses identical tool results for generation and token counting", async () => {
    const organizationId = "org_gateway_runtime_compression";
    fixture = await captureFixture(organizationId, "hash_only", false, {
      anthropicOptions: { outputText: "compressed answer" }
    });
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy(organizationId, {
      mode: "compress_lossless",
      minOriginalBytes: 512,
      minSavingsTokens: 0,
      enabledRules: ["mcp-json-whitespace"]
    });
    const verbose = JSON.stringify(
      { items: Array.from({ length: 120 }, (_, id) => ({ id, note: null })) },
      null,
      2
    );
    const messages = [
      { role: "user", content: "List the issues" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "mcp__linear__list_issues", input: {} }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: verbose }]
      }
    ];

    const generation = await postJson(`${fixture.proxyUrl}/v1/messages`, gatewayHeaders("proxy-token"), {
      model: "fable",
      messages,
      max_tokens: 128
    });
    expect(generation.status).toBe(200);
    await generation.text();
    const count = await postJson(
      `${fixture.proxyUrl}/v1/messages/count_tokens`,
      gatewayHeaders("proxy-token"),
      { model: "fable", messages }
    );
    expect(count.status).toBe(200);
    await count.text();

    const generatedContent = fixture.anthropic.records.find((record) => record.path === "/messages")
      ?.body.messages[2].content[0].content;
    const countedContent = fixture.anthropic.records.find((record) => record.path === "/messages/count_tokens")
      ?.body.messages[2].content[0].content;
    expect(typeof generatedContent).toBe("string");
    expect(generatedContent.length).toBeLessThan(verbose.length);
    expect(countedContent).toBe(generatedContent);
  });

  it("keeps the same cached prefix intact for generation and token counting", async () => {
    const organizationId = "org_gateway_runtime_cached_compression";
    fixture = await captureFixture(organizationId, "hash_only", false, {
      anthropicOptions: { outputText: "cache-safe answer" }
    });
    await fixture.persistence.organizationSettings.setToolResultCompressionPolicy(organizationId, {
      mode: "compress_lossless",
      minOriginalBytes: 512,
      minSavingsTokens: 0,
      enabledRules: ["mcp-json-whitespace"]
    });
    const sessionHeaders = {
      ...gatewayHeaders("proxy-token"),
      "x-claude-code-session-id": "gateway-cache-window-session"
    };
    const warm = await postJson(`${fixture.proxyUrl}/v1/messages`, sessionHeaders, {
      model: "fable",
      messages: [{ role: "user", content: "Warm the cache" }],
      max_tokens: 64
    });
    expect(warm.status).toBe(200);
    await warm.text();
    await fixture.db
      .update(usageLedger)
      .set({ cachedInputTokens: 10 })
      .where(eq(usageLedger.kind, "provider"));

    const verbose = JSON.stringify(
      { items: Array.from({ length: 120 }, (_, id) => ({ id, note: null })) },
      null,
      2
    );
    const messages = [
      { role: "user", content: "List the issues" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "mcp__linear__list_issues", input: {} }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: verbose }]
      },
      { role: "assistant", content: "I found several issues." },
      { role: "user", content: "Continue" }
    ];
    const generation = await postJson(`${fixture.proxyUrl}/v1/messages`, sessionHeaders, {
      model: "fable",
      messages,
      max_tokens: 128
    });
    expect(generation.status).toBe(200);
    await generation.text();
    const count = await postJson(
      `${fixture.proxyUrl}/v1/messages/count_tokens`,
      sessionHeaders,
      { model: "fable", messages }
    );
    expect(count.status).toBe(200);
    await count.text();

    const generationCall = fixture.anthropic.records.findLast((record) => record.path === "/messages");
    const countCall = fixture.anthropic.records.findLast((record) => record.path === "/messages/count_tokens");
    expect(generationCall?.body.messages[2].content[0].content).toBe(verbose);
    expect(countCall?.body.messages[2].content[0].content).toBe(verbose);
  });

});
