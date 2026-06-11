import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { consoleAgentConversations, consoleAgentRuns, defaultWorkspaceId, organizationMembers, users } from "@prompt-proxy/db";

import { assistantText, assistantToolCall, gatedStream, scriptedStream } from "./consoleAgentTestKit.js";
import {
  adminGet,
  adminPost,
  captureFixture,
  readSseUntil,
  type PromptTestFixture
} from "./promptTestFixture.js";

const ORG = "org_agent_routes";

describe("console agent HTTP routes", () => {
  let fixture: PromptTestFixture;

  beforeAll(async () => {
    fixture = await captureFixture(ORG, "raw_text", false, {
      consoleAgentStreamFn: scriptedStream([
        assistantToolCall("overview_get_v1", {}),
        assistantText("The organization has activity."),
        assistantText("Second turn answer.")
      ])
    });
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
  });

  it("requires an admin session", async () => {
    const response = await fetch(`${fixture.proxyUrl}/admin/console-agent/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(401);
  });

  it("rejects member-role sessions on every console agent route", async () => {
    await fixture.db.insert(users).values({ id: "user_member_role" });
    await fixture.db.insert(organizationMembers).values({
      organizationId: ORG,
      userId: "user_member_role",
      role: "member",
      status: "active"
    });
    const session = await fixture.persistence.adminSessions.create({
      organizationId: ORG,
      userId: "user_member_role",
      ttlSeconds: 3600
    });
    if (!session) throw new Error("member session missing");
    const headers = {
      cookie: `prompt_proxy_session=${encodeURIComponent(session.token)}`,
      "content-type": "application/json"
    };

    const routes: Array<[string, string]> = [
      ["POST", "/admin/console-agent/conversations"],
      ["GET", "/admin/console-agent/conversations"],
      ["GET", "/admin/console-agent/conversations/conv_x"],
      ["POST", "/admin/console-agent/conversations/conv_x/messages"],
      ["GET", "/admin/console-agent/runs/run_x/events"],
      ["POST", "/admin/console-agent/runs/run_x/cancel"],
      ["POST", "/admin/console-agent/proposals/prop_x/approve"],
      ["POST", "/admin/console-agent/proposals/prop_x/reject"]
    ];
    for (const [method, path] of routes) {
      const response = await fetch(`${fixture.proxyUrl}${path}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify({}) : undefined
      });
      expect(`${method} ${path} -> ${response.status}`).toBe(`${method} ${path} -> 403`);
    }
  });

  it("creates, lists, and reads conversations creator-scoped", async () => {
    const created = await adminPost(fixture, "/admin/console-agent/conversations", {
      title: "Routing questions"
    });
    expect(created.status).toBe(201);
    const { conversation } = await created.json();
    expect(conversation.title).toBe("Routing questions");

    const list = await adminGet(fixture, "/admin/console-agent/conversations");
    expect(list.data.map((row: { id: string }) => row.id)).toContain(conversation.id);

    await fixture.db.insert(users).values({ id: "user_someone_else" });
    await fixture.db.insert(consoleAgentConversations).values({
      id: "conv_foreign",
      organizationId: ORG,
      createdByUserId: "user_someone_else"
    });
    const listAfter = await adminGet(fixture, "/admin/console-agent/conversations");
    expect(listAfter.data.map((row: { id: string }) => row.id)).not.toContain("conv_foreign");

    const foreign = await fetch(`${fixture.proxyUrl}/admin/console-agent/conversations/conv_foreign`, {
      headers: fixture.adminHeaders
    });
    expect(foreign.status).toBe(404);
  });

  it("runs a turn end to end over HTTP and replays it via SSE", async () => {
    const created = await adminPost(fixture, "/admin/console-agent/conversations", {});
    const { conversation } = await created.json();

    const message = await adminPost(
      fixture,
      `/admin/console-agent/conversations/${conversation.id}/messages`,
      { text: "What is going on in this org?", pageScope: { page: "overview" } }
    );
    expect(message.status).toBe(202);
    const { runId } = await message.json();
    expect(runId).toBeTruthy();

    await waitForRunCompletion(fixture, conversation.id);

    const detail = await adminGet(fixture, `/admin/console-agent/conversations/${conversation.id}`);
    expect(detail.messages.map((row: { role: string }) => row.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[0].pageScope).toEqual({ page: "overview" });
    expect(detail.messages[1].content).toEqual({ text: "The organization has activity." });

    const sse = await fetch(`${fixture.proxyUrl}/admin/console-agent/runs/${runId}/events`, {
      headers: fixture.adminHeaders
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    const body = await sse.text();
    expect(body).toContain("event: run_started");
    expect(body).toContain("event: tool_call_started");
    expect(body).toContain("event: tool_call_finished");
    expect(body).toContain("event: message_finished");
    expect(body).toContain("event: run_finished");

    const replayFrom = await fetch(
      `${fixture.proxyUrl}/admin/console-agent/runs/${runId}/events`,
      { headers: { ...fixture.adminHeaders, "last-event-id": "3" } }
    );
    const tail = await replayFrom.text();
    expect(tail).not.toContain("event: run_started");
    expect(tail).toContain("event: run_finished");

    const cancel = await adminPost(fixture, `/admin/console-agent/runs/${runId}/cancel`, {});
    expect(await cancel.json()).toEqual({ cancelled: false });
  });

  it("resolves proposals over HTTP and lists them in the conversation detail", async () => {
    const created = await adminPost(fixture, "/admin/console-agent/conversations", {});
    const { conversation } = await created.json();
    const run = await fixture.db
      .insert(consoleAgentRuns)
      .values({
        id: "run_for_proposals",
        organizationId: ORG,
      conversationId: conversation.id,
        status: "awaiting_approval"
      })
      .returning();
    expect(run).toHaveLength(1);
    fixture.persistence.consoleAgentProposals.registerExecutor("widgets.create.v1", {
      execute: async () => ({ applied: true })
    });

    const proposal = await fixture.persistence.consoleAgentProposals.create({
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      conversationId: conversation.id,
      runId: "run_for_proposals",
      capabilityKey: "widgets.create.v1",
      proposedByUserId: "local-user",
      input: { name: "w" },
      preview: { diff: "+w" }
    });

    const detail = await adminGet(fixture, `/admin/console-agent/conversations/${conversation.id}`);
    expect(detail.proposals.map((row: { id: string }) => row.id)).toContain(proposal.id);
    expect(detail.proposals[0].status).toBe("pending");

    const approve = await adminPost(fixture, `/admin/console-agent/proposals/${proposal.id}/approve`, {});
    expect(approve.status).toBe(200);
    const approved = await approve.json();
    expect(approved.outcome).toBe("approved");
    expect(approved.output).toEqual({ applied: true });
    expect(approved.proposal.resolvedByUserId).toBe("local-user");

    const again = await adminPost(fixture, `/admin/console-agent/proposals/${proposal.id}/approve`, {});
    expect(again.status).toBe(409);
    expect((await again.json()).outcome).toBe("already_resolved");

    const second = await fixture.persistence.consoleAgentProposals.create({
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      conversationId: conversation.id,
      runId: "run_for_proposals",
      capabilityKey: "widgets.create.v1",
      proposedByUserId: "local-user",
      input: { name: "w2" },
      preview: { diff: "+w2" }
    });
    const reject = await adminPost(fixture, `/admin/console-agent/proposals/${second.id}/reject`, {});
    expect(reject.status).toBe(200);
    expect((await reject.json()).outcome).toBe("rejected");

    const missing = await adminPost(fixture, "/admin/console-agent/proposals/prop_missing/approve", {});
    expect(missing.status).toBe(404);

    fixture.persistence.consoleAgentProposals.registerExecutor("widgets.stale.v1", {
      execute: async () => ({}),
      isStale: async () => true
    });
    const staleProposal = await fixture.persistence.consoleAgentProposals.create({
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      conversationId: conversation.id,
      runId: "run_for_proposals",
      capabilityKey: "widgets.stale.v1",
      proposedByUserId: "local-user",
      input: {},
      preview: { diff: "stale" }
    });
    const stale = await adminPost(fixture, `/admin/console-agent/proposals/${staleProposal.id}/approve`, {});
    expect(stale.status).toBe(409);
    expect((await stale.json()).outcome).toBe("stale");

    const unsupportedProposal = await fixture.persistence.consoleAgentProposals.create({
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      conversationId: conversation.id,
      runId: "run_for_proposals",
      capabilityKey: "widgets.never_registered.v1",
      proposedByUserId: "local-user",
      input: {},
      preview: { diff: "x" }
    });
    const unsupported = await adminPost(
      fixture,
      `/admin/console-agent/proposals/${unsupportedProposal.id}/approve`,
      {}
    );
    expect(unsupported.status).toBe(501);
    expect((await unsupported.json()).outcome).toBe("unsupported");
  });

  it("returns 404 for missing and foreign runs", async () => {
    const missingRun = await fetch(`${fixture.proxyUrl}/admin/console-agent/runs/run_missing/events`, {
      headers: fixture.adminHeaders
    });
    expect(missingRun.status).toBe(404);

    await fixture.db.insert(consoleAgentRuns).values({
      id: "run_foreign",
      organizationId: ORG,
      conversationId: "conv_foreign",
      status: "finished"
    });
    const foreignEvents = await fetch(
      `${fixture.proxyUrl}/admin/console-agent/runs/run_foreign/events`,
      { headers: fixture.adminHeaders }
    );
    expect(foreignEvents.status).toBe(404);
    const foreignCancel = await adminPost(fixture, "/admin/console-agent/runs/run_foreign/cancel", {});
    expect(foreignCancel.status).toBe(404);
  });

  it("rejects empty messages", async () => {
    const created = await adminPost(fixture, "/admin/console-agent/conversations", {});
    const { conversation } = await created.json();
    const response = await adminPost(
      fixture,
      `/admin/console-agent/conversations/${conversation.id}/messages`,
      { text: "   " }
    );
    expect(response.status).toBe(400);
  });
});

describe("console agent SSE live continuation", () => {
  let fixture: PromptTestFixture;
  let release: () => void;

  beforeAll(async () => {
    const gated = gatedStream([assistantText("Live answer.")]);
    release = gated.release;
    fixture = await captureFixture("org_agent_live", "raw_text", false, {
      consoleAgentStreamFn: gated.streamFn
    });
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
  });

  it("streams live events after replay and rejects concurrent turns", async () => {
    const created = await adminPost(fixture, "/admin/console-agent/conversations", {});
    const { conversation } = await created.json();

    const message = await adminPost(
      fixture,
      `/admin/console-agent/conversations/${conversation.id}/messages`,
      { text: "Stream me an answer." }
    );
    expect(message.status).toBe(202);
    const { runId } = await message.json();

    const concurrent = await adminPost(
      fixture,
      `/admin/console-agent/conversations/${conversation.id}/messages`,
      { text: "Second message while running." }
    );
    expect(concurrent.status).toBe(409);
    expect(await concurrent.json()).toEqual({ error: "run_already_active" });

    const sse = await fetch(`${fixture.proxyUrl}/admin/console-agent/runs/${runId}/events`, {
      headers: fixture.adminHeaders
    });
    expect(sse.status).toBe(200);

    release();
    const body = await readSseUntil(sse, (text) => text.includes("event: run_finished"));
    expect(body).toContain("event: run_started");
    expect(body).toContain("event: message_finished");
    expect(body).toContain("Live answer.");
    expect(body).toContain("event: run_finished");
  });
});

async function waitForRunCompletion(fixture: PromptTestFixture, conversationId: string, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    const detail = await adminGet(fixture, `/admin/console-agent/conversations/${conversationId}`);
    if (detail.messages.some((message: { role: string }) => message.role === "assistant")) return;
    if (Date.now() - start > timeoutMs) throw new Error("run did not complete in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
