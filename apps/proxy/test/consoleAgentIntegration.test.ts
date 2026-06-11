import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  consoleAgentConversations,
  events,
  promptAccessAudit,
  promptArtifacts,
  requests
} from "@prompt-proxy/db";

import { CONSOLE_AGENT_PROMPT_ACCESS_PATH } from "../src/console-agent/capabilities/read.js";
import {
  adminGet,
  adminPost,
  captureFixture,
  readSseUntil,
  sessionPrompt,
  sseTerminalSeen,
  usageRequest,
  waitFor,
  type PromptTestFixture
} from "./promptTestFixture.js";

const ORG = "org_agent_integration";
const SECRET_PROMPT = "the integration secret prompt body";

// End-to-end: console route -> runtime -> pi-ai over HTTP -> the proxy's own
// /v1/messages surface -> mock Anthropic upstream, with no provider
// credentials and no scripted StreamFn.
describe("console agent integration", () => {
  let fixture: PromptTestFixture;
  let conversationId: string;
  let runId: string;

  beforeAll(async () => {
    const port = await reservePort();
    fixture = await captureFixtureRetrying(ORG, {
      port,
      anthropicOptions: {
        scriptedResponses: [
          { type: "tool_use", name: "requests_search_v1", input: { limit: 5 } },
          { type: "tool_use", name: "prompts_get_v1", input: { artifactId: "artifact_int" } },
          { type: "text", text: "One request exists and I read its prompt artifact." },
          { type: "hang" }
        ]
      }
    });

    const when = new Date("2026-06-09T10:00:00.000Z");
    await fixture.db.insert(requests).values([
      usageRequest("req_int", ORG, "local-user", null as never, "anthropic-messages", when)
    ]);
    await fixture.db.insert(promptArtifacts).values([
      sessionPrompt("artifact_int", ORG, "req_int", SECRET_PROMPT, when)
    ]);
  }, 90_000);

  afterAll(async () => {
    await fixture.close();
  });

  it("authenticates and creates a conversation", async () => {
    const created = await adminPost(fixture, "/admin/console-agent/conversations", {
      title: "Integration"
    });
    expect(created.status).toBe(201);
    conversationId = (await created.json()).conversation.id;
  });

  it("runs a multi-tool turn through the proxy's own LLM surface", async () => {
    if (!conversationId) throw new Error("conversation-creation phase did not complete");
    const message = await adminPost(
      fixture,
      `/admin/console-agent/conversations/${conversationId}/messages`,
      { text: "How many requests are there, and what did the latest prompt say?" }
    );
    expect(message.status).toBe(202);
    runId = (await message.json()).runId;

    const sse = await fetch(`${fixture.proxyUrl}/admin/console-agent/runs/${runId}/events`, {
      headers: fixture.adminHeaders
    });
    const body = await readSseUntil(sse, sseTerminalSeen);
    expect(body).toContain("event: run_started");
    expect(body).toContain("requests_search_v1");
    expect(body).toContain("prompts_get_v1");
    expect(body).toContain("event: run_finished");
    expect(body).not.toContain(SECRET_PROMPT);
  });

  it("serves the transcript with the final assistant answer", async () => {
    if (!runId) throw new Error("turn phase did not complete");
    const detail = await adminGet(fixture, `/admin/console-agent/conversations/${conversationId}`);
    expect(detail.messages.map((row: { role: string }) => row.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[1].content).toEqual({
      text: "One request exists and I read its prompt artifact."
    });
  });

  it("audits capability execution and prompt access", async () => {
    const capabilityAudits = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "console_agent.capability.executed"));
    expect(capabilityAudits.length).toBe(2);

    const accessRows = await fixture.db
      .select()
      .from(promptAccessAudit)
      .where(eq(promptAccessAudit.artifactId, "artifact_int"));
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0]?.accessPath).toBe(`${CONSOLE_AGENT_PROMPT_ACCESS_PATH}#${runId}`);
    expect(accessRows[0]?.userId).toBe("local-user");
  });

  it("keeps raw prompt text out of persisted state while metering its own usage", async () => {
    const [conversation] = await fixture.db
      .select()
      .from(consoleAgentConversations)
      .where(eq(consoleAgentConversations.id, conversationId));
    const sessionStateJson = JSON.stringify(conversation?.sessionState);
    expect(sessionStateJson).not.toContain(SECRET_PROMPT);
    expect(sessionStateJson).toContain("artifact_int");
    expect(sessionStateJson).toContain('"redacted":true');

    const proxied = await fixture.db
      .select()
      .from(requests)
      .where(eq(requests.requestedModel, "claude-router-hard"));
    expect(proxied.length).toBeGreaterThanOrEqual(3);
  });

  it("cancels a hanging run cleanly", async () => {
    const created = await adminPost(fixture, "/admin/console-agent/conversations", {});
    const cancelConversation = (await created.json()).conversation.id;
    const message = await adminPost(
      fixture,
      `/admin/console-agent/conversations/${cancelConversation}/messages`,
      { text: "This upstream call hangs." }
    );
    expect(message.status).toBe(202);
    const hangingRunId = (await message.json()).runId;

    await waitFor(async () => {
      const cancel = await adminPost(fixture, `/admin/console-agent/runs/${hangingRunId}/cancel`, {});
      return (await cancel.json()).cancelled === true;
    });

    await waitFor(async () => {
      const sse = await fetch(
        `${fixture.proxyUrl}/admin/console-agent/runs/${hangingRunId}/events`,
        { headers: fixture.adminHeaders }
      );
      const body = await readSseUntil(sse, sseTerminalSeen);
      return body.includes('"status":"cancelled"');
    });
  });
});

async function captureFixtureRetrying(
  organizationId: string,
  options: Parameters<typeof captureFixture>[3]
) {
  try {
    return await captureFixture(organizationId, "raw_text", false, options);
  } catch (error) {
    if (error instanceof Error && error.message.includes("EADDRINUSE")) {
      return captureFixture(organizationId, "raw_text", false, {
        ...options,
        port: await reservePort()
      });
    }
    throw error;
  }
}

function reservePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
