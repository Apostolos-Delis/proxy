import { afterEach, describe, expect, it } from "vitest";

import { defaultWorkspaceId, events } from "@proxy/db";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

let activeFixture: PromptTestFixture | undefined;

afterEach(async () => {
  await activeFixture?.close();
  activeFixture = undefined;
});

describe("promptCachePlans admin query", () => {
  it("groups plan events by provider, model, mode, control status, and reason", async () => {
    const organizationId = "org_prompt_cache_plans";
    const workspaceId = defaultWorkspaceId(organizationId);
    activeFixture = await captureFixture(organizationId);
    await activeFixture.db.insert(events).values([
      promptCachePlanEvent("plan_1", organizationId, workspaceId, {
        provider: "openai",
        model: "gpt-5.5",
        mode: "implicit",
        appliedControls: ["implicit_prefix_caching", "cache_key_preserved"],
        skippedControls: []
      }),
      promptCachePlanEvent("plan_2", organizationId, workspaceId, {
        provider: "openai",
        model: "gpt-5.5",
        mode: "implicit",
        appliedControls: ["implicit_prefix_caching"],
        skippedControls: [{ control: "cross_dialect_cache_fields", reason: "translated_request" }]
      }),
      promptCachePlanEvent("plan_3", organizationId, workspaceId, {
        provider: "anthropic",
        model: "claude-opus",
        mode: "observe",
        appliedControls: [],
        skippedControls: [{ control: "top_level_auto_breakpoint", reason: "setting_disabled" }]
      })
    ]);

    const result = (await adminGql(
      activeFixture.proxyUrl,
      activeFixture.adminHeaders,
      `query {
        promptCachePlans {
          totalPlans
          sampled
          plans { provider model mode count appliedControls skippedControls }
          controls { provider model mode control status reason count }
        }
      }`
    )).data?.promptCachePlans;

    expect(result.totalPlans).toBe(3);
    expect(result.sampled).toBe(false);
    expect(result.plans).toContainEqual({
      provider: "openai",
      model: "gpt-5.5",
      mode: "implicit",
      count: 2,
      appliedControls: 3,
      skippedControls: 1
    });
    expect(result.controls).toContainEqual({
      provider: "openai",
      model: "gpt-5.5",
      mode: "implicit",
      control: "implicit_prefix_caching",
      status: "applied",
      reason: "none",
      count: 2
    });
    expect(result.controls).toContainEqual({
      provider: "anthropic",
      model: "claude-opus",
      mode: "observe",
      control: "top_level_auto_breakpoint",
      status: "skipped",
      reason: "setting_disabled",
      count: 1
    });
  });
});

function promptCachePlanEvent(
  id: string,
  organizationId: string,
  workspaceId: string,
  payload: Record<string, unknown>
) {
  return {
    id,
    sequence: 1,
    schemaVersion: 1,
    organizationId,
    workspaceId,
    scopeType: "request",
    scopeId: `request_${id}`,
    correlationId: `request_${id}`,
    actorType: "proxy",
    actorId: "proxy",
    producer: "proxy.prompt-cache",
    eventType: "prompt_cache.plan_applied",
    payloadHash: `sha256:${id}`,
    sensitivity: "internal",
    redactionState: "not_applicable",
    payload,
    metadata: {},
    createdAt: new Date("2026-06-27T12:00:00.000Z")
  };
}
