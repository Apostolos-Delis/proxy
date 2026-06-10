import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { Agent } from "@earendil-works/pi-agent-core";
import { createTransactionalDatabase, defaultWorkspaceId, eventOutbox, events, organizations } from "@prompt-proxy/db";

import { CapabilityPolicy, CapabilityInputError } from "../src/console-agent/policy.js";
import { CONSOLE_AGENT_PRODUCER } from "../src/persistence/consoleAgentAudit.js";
import { ConsoleAgentStore } from "../src/persistence/consoleAgentStore.js";
import { CapabilityRegistry, type CapabilityContext } from "../src/console-agent/registry.js";
import { capabilityToolName, capabilityTools } from "../src/console-agent/tools.js";
import {
  assistantText,
  assistantToolCall,
  migratedPgliteDb,
  scriptedStream,
  stubModel
} from "./consoleAgentTestKit.js";

const context: CapabilityContext = {
  organizationId: "org_capabilities",
  workspaceId: defaultWorkspaceId("org_capabilities"),
  userId: "user_admin",
  conversationId: "conv_1",
  runId: "run_1"
};

function lookupInput() {
  return z.object({ id: z.string(), limit: z.number().optional() });
}

function buildRegistry() {
  return new CapabilityRegistry()
    .register({
      key: "widgets.lookup.v1",
      description: "Look up a widget by id.",
      input: lookupInput(),
      sideEffect: "none",
      handler: async (_context, input) => ({ widget: { id: input.id, name: `Widget ${input.id}` } })
    })
    .register({
      key: "widgets.create.v1",
      description: "Create a widget.",
      input: z.object({ name: z.string() }),
      sideEffect: "write",
      handler: async () => ({ created: true })
    });
}

describe("console agent capability registry and policy", () => {
  let fixture: Awaited<ReturnType<typeof migratedPgliteDb>>;

  beforeAll(async () => {
    fixture = await migratedPgliteDb();
    await fixture.db.insert(organizations).values({
      id: context.organizationId,
      slug: "org-capabilities",
      name: "Org Capabilities"
    });
  });

  afterAll(async () => {
    await fixture.client.close();
  });

  function auditor() {
    return new ConsoleAgentStore(createTransactionalDatabase(fixture.db), fixture.db);
  }

  it("generates pi tools from registry entries with matching schema and description", () => {
    const policy = new CapabilityPolicy(buildRegistry(), auditor());
    const tools = capabilityTools(policy, context);

    expect(tools.map((tool) => tool.name)).toEqual(["widgets_create_v1", "widgets_lookup_v1"]);
    const lookup = tools.find((tool) => tool.name === "widgets_lookup_v1");
    expect(lookup?.label).toBe("widgets.lookup.v1");
    expect(lookup?.description).toBe("Look up a widget by id.");
    expect(lookup?.parameters).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    });
    expect(lookup?.parameters).not.toHaveProperty("$schema");
    expect(capabilityToolName("overview.get.v1")).toBe("overview_get_v1");
  });

  it("executes read capabilities and appends the audit event with outbox row", async () => {
    const db = fixture.db;
    const policy = new CapabilityPolicy(buildRegistry(), auditor());

    const decision = await policy.call(context, "widgets.lookup.v1", { id: "w_1" });

    expect(decision).toEqual({
      decision: "executed",
      output: { widget: { id: "w_1", name: "Widget w_1" } }
    });
    const eventRows = await db.select().from(events);
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      organizationId: context.organizationId,
      scopeType: "console_agent_conversation",
      scopeId: context.conversationId,
      correlationId: context.runId,
      actorId: context.userId,
      producer: CONSOLE_AGENT_PRODUCER,
      eventType: "console_agent.capability.executed",
      payload: {
        capabilityKey: "widgets.lookup.v1",
        conversationId: context.conversationId,
        runId: context.runId
      }
    });
    const outboxRows = await db.select().from(eventOutbox);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.eventId).toBe(eventRows[0]?.id);
  });

  it("denies unknown capability keys", async () => {
    const policy = new CapabilityPolicy(buildRegistry(), auditor());
    const decision = await policy.call(context, "widgets.delete.v1", {});
    expect(decision).toEqual({
      decision: "denied",
      reason: "Unknown capability: widgets.delete.v1"
    });
  });

  it("throws actionable validation errors with field paths", async () => {
    const policy = new CapabilityPolicy(buildRegistry(), auditor());
    await expect(policy.call(context, "widgets.lookup.v1", { limit: "ten" })).rejects.toThrow(
      CapabilityInputError
    );
    await expect(policy.call(context, "widgets.lookup.v1", { limit: "ten" })).rejects.toThrow(/id:/);
  });

  it("refuses write capabilities until the proposal flow exists", async () => {
    const policy = new CapabilityPolicy(buildRegistry(), auditor());
    await expect(policy.call(context, "widgets.create.v1", { name: "w" })).rejects.toThrow(
      /proposal flow/
    );
  });

  it("rejects duplicate capability registrations", () => {
    const registry = buildRegistry();
    expect(() =>
      registry.register({
        key: "widgets.lookup.v1",
        description: "Duplicate.",
        input: z.object({}),
        sideEffect: "none",
        handler: async () => ({})
      })
    ).toThrow(/already registered/);
  });

  it("drives a generated tool end to end through the pi agent loop", async () => {
    const policy = new CapabilityPolicy(buildRegistry(), auditor());
    const tools = capabilityTools(policy, context);
    const agent = new Agent({
      initialState: {
        systemPrompt: "You are the console agent.",
        model: stubModel,
        thinkingLevel: "off",
        tools
      },
      streamFn: scriptedStream([
        assistantToolCall("widgets_lookup_v1", { id: "w_42" }),
        assistantText("Widget w_42 found.")
      ])
    });

    await agent.prompt("Look up widget w_42.");
    await agent.waitForIdle();

    const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
    if (!toolResult || toolResult.role !== "toolResult") throw new Error("expected a tool result");
    expect(toolResult.isError).toBe(false);
    const first = toolResult.content[0];
    if (!first || first.type !== "text") throw new Error("expected text tool result content");
    expect(JSON.parse(first.text)).toEqual({
      decision: "executed",
      output: { widget: { id: "w_42", name: "Widget w_42" } }
    });
  });

});
