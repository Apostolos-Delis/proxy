import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentSessions, createTransactionalDatabase, defaultWorkspaceId, promptAccessAudit, promptArtifacts, requests, routeDecisions, users } from "@prompt-proxy/db";

import { CapabilityPolicy } from "../src/console-agent/policy.js";
import { ConsoleAgentStore } from "../src/persistence/consoleAgentStore.js";
import { executed } from "./consoleAgentTestKit.js";
import { CapabilityRegistry, type CapabilityContext } from "../src/console-agent/registry.js";
import { capabilityTools } from "../src/console-agent/tools.js";
import {
  CONSOLE_AGENT_PROMPT_ACCESS_PATH,
  registerReadCapabilities
} from "../src/console-agent/capabilities/read.js";
import {
  captureFixture,
  sessionPrompt,
  usageDecision,
  usageRequest,
  type PromptTestFixture
} from "./promptTestFixture.js";

const ORG = "org_agent_read";

const context: CapabilityContext = {
  organizationId: ORG,
  workspaceId: defaultWorkspaceId(ORG),
  userId: "local-user",
  conversationId: "conv_read",
  runId: "run_read"
};

describe("console agent read capabilities", () => {
  let fixture: PromptTestFixture;
  let policy: CapabilityPolicy;

  beforeAll(async () => {
    fixture = await captureFixture(ORG);
    const registry = registerReadCapabilities(new CapabilityRegistry(), {
      adminQueries: () => fixture.persistence.adminQueries.forScope(ORG, defaultWorkspaceId(ORG)),
      promptAccessAudit: fixture.persistence.promptAccessAudit,
      catalog: fixture.catalog
    });
    policy = new CapabilityPolicy(registry, new ConsoleAgentStore(createTransactionalDatabase(fixture.db), fixture.db));

    const when = new Date("2026-06-08T12:00:00.000Z");
    await fixture.db.insert(users).values([{ id: "user_read" }]);
    await fixture.db.insert(agentSessions).values([
      { id: "session_read", organizationId: ORG, workspaceId: defaultWorkspaceId(ORG), userId: "user_read", surface: "openai-responses" }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("req_read_fast", ORG, "user_read", "session_read", "openai-responses", when),
      usageRequest("req_read_hard", ORG, "user_read", "session_read", "anthropic-messages", when)
    ]);
    await fixture.db.insert(routeDecisions).values([
      {
        ...usageDecision("dec_read_fast", "req_read_fast", ORG, "fast", "openai", "gpt-fast"),
        classifier: { recommended_route: "fast", confidence: 0.9 }
      },
      usageDecision("dec_read_hard", "req_read_hard", ORG, "hard", "anthropic", "claude-hard")
    ]);
    await fixture.db.insert(promptArtifacts).values([
      sessionPrompt("artifact_read", ORG, "req_read_fast", "what is the secret prompt text", when)
    ]);
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
  });

  it("registers the thirteen read capabilities with unique tool names", () => {
    const tools = capabilityTools(policy, context);
    expect(tools).toHaveLength(13);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(13);
    expect(tools.map((tool) => tool.label)).toEqual([
      "api_keys.get.v1",
      "api_keys.list.v1",
      "models.catalog.list.v1",
      "overview.get.v1",
      "prompts.get.v1",
      "prompts.search.v1",
      "requests.get.v1",
      "requests.search.v1",
      "routing_configs.get.v1",
      "routing_configs.list.v1",
      "sessions.get.v1",
      "sessions.search.v1",
      "usage.analytics.v1"
    ]);
  });

  it("searches requests with filters, limit, and compact summaries", async () => {
    const byRoute = executed(await policy.call(context, "requests.search.v1", { route: "hard" }));
    const requestsOut = byRoute.requests as Array<Record<string, unknown>>;
    expect(requestsOut.map((row) => row.requestId)).toEqual(["req_read_hard"]);
    expect(requestsOut[0]).not.toHaveProperty("classifier");

    const limited = executed(await policy.call(context, "requests.search.v1", { limit: 1 }));
    expect(limited.count).toBe(1);
  });

  it("returns request detail with classifier rationale and events", async () => {
    const detail = executed(await policy.call(context, "requests.get.v1", { requestId: "req_read_fast" }));
    expect(detail.found).toBe(true);
    const request = detail.request as Record<string, unknown>;
    expect(request.finalRoute).toBe("fast");
    expect(request.classifier).toEqual({ recommended_route: "fast", confidence: 0.9 });

    const missing = executed(await policy.call(context, "requests.get.v1", { requestId: "req_nope" }));
    expect(missing.found).toBe(false);
  });

  it("lists prompt artifacts as metadata only", async () => {
    const result = executed(await policy.call(context, "prompts.search.v1", {}));
    const prompts = result.prompts as Array<Record<string, unknown>>;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.artifactId).toBe("artifact_read");
    expect(prompts[0]).not.toHaveProperty("preview");
    expect(prompts[0]).not.toHaveProperty("rawText");
    expect(prompts[0]).not.toHaveProperty("classifier");
    expect(prompts[0]?.contentHash).toBe("sha256:artifact_read");
  });

  it("reads prompt raw text and appends an agent-mediated access audit row", async () => {
    const result = executed(await policy.call(context, "prompts.get.v1", { artifactId: "artifact_read" }));
    expect(result.found).toBe(true);
    expect(result.rawText).toBe("what is the secret prompt text");

    const auditRows = await fixture.db
      .select()
      .from(promptAccessAudit)
      .where(eq(promptAccessAudit.artifactId, "artifact_read"));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      organizationId: ORG,
      artifactId: "artifact_read",
      requestId: "req_read_fast",
      userId: "local-user",
      route: "fast",
      accessPath: `${CONSOLE_AGENT_PROMPT_ACCESS_PATH}#run_read`
    });
  });

  it("serves the model catalog with route aliases and costs", async () => {
    const result = executed(await policy.call(context, "models.catalog.list.v1", {}));
    const models = result.models as Array<Record<string, unknown>>;
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => typeof model.route === "string")).toBe(true);
  });

  it("serves organization totals and route quality in the overview", async () => {
    const result = executed(await policy.call(context, "overview.get.v1", {}));
    expect(result.organizationId).toBe(ORG);
    expect(typeof result.requestCount).toBe("number");
    expect(result.totals).toBeTruthy();
    expect(result.routeQuality).toBeTruthy();
  });

  it("covers the list and analytics capabilities end to end", async () => {
    const usage = executed(await policy.call(context, "usage.analytics.v1", { groupBy: "route" }));
    expect(usage.groupBy).toBe("route");
    expect(Array.isArray(usage.data)).toBe(true);
    expect(usage.totals).toBeTruthy();

    const sessions = executed(await policy.call(context, "sessions.search.v1", { surface: "openai-responses" }));
    expect(sessions.count).toBe(1);
    const sessionRows = sessions.sessions as Array<Record<string, unknown>>;
    expect(sessionRows[0]?.sessionId).toBe("session_read");

    const configs = executed(await policy.call(context, "routing_configs.list.v1", {}));
    const configRows = configs.data as Array<Record<string, unknown>>;
    expect(configRows.length).toBeGreaterThan(0);

    const configDetail = executed(
      await policy.call(context, "routing_configs.get.v1", { configId: configRows[0]?.id as string })
    );
    expect(configDetail.found).toBe(true);
    expect(Array.isArray(configDetail.versions)).toBe(true);

    const keys = executed(await policy.call(context, "api_keys.list.v1", {}));
    const keyRows = keys.data as Array<Record<string, unknown>>;
    expect(keyRows.length).toBeGreaterThan(0);

    const keyDetail = executed(
      await policy.call(context, "api_keys.get.v1", { apiKeyId: keyRows[0]?.id as string })
    );
    expect(keyDetail.found).toBe(true);
  });

  it("strips prompt previews from session detail", async () => {
    const result = executed(await policy.call(context, "sessions.get.v1", { sessionId: "session_read" }));
    expect(result.found).toBe(true);
    const artifacts = result.promptArtifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).not.toHaveProperty("preview");
    expect(artifacts[0]).not.toHaveProperty("rawText");
    expect(artifacts[0]).not.toHaveProperty("redactedText");

    const missing = executed(await policy.call(context, "sessions.get.v1", { sessionId: "session_nope" }));
    expect(missing.found).toBe(false);
  });

  it("reports found:false for unknown config and api key ids", async () => {
    const config = executed(await policy.call(context, "routing_configs.get.v1", { configId: "config_nope" }));
    expect(config.found).toBe(false);

    const key = executed(await policy.call(context, "api_keys.get.v1", { apiKeyId: "key_nope" }));
    expect(key.found).toBe(false);
  });
});
