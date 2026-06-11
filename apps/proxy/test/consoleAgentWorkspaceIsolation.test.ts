import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  agentSessions,
  defaultWorkspaceId,
  requests,
  routingConfigs,
  routingConfigVersions,
  workspaces
} from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";

import { routingConfigHash } from "../src/persistence/routingConfigAdmin.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const ORG = "org_agent_ws_isolation";
const WS_B = `${ORG}:workspace:decoy`;

// The agent is pinned to the org's default workspace. Decoy rows in a second
// workspace must be invisible to every agent read and staleness check — this
// is the test that fails if any agent-path query drops the workspace filter.
describe("console agent workspace isolation", () => {
  let fixture: PromptTestFixture;
  let decoyConfig: RoutingConfig;

  beforeAll(async () => {
    fixture = await captureFixture(ORG);

    await fixture.db.insert(workspaces).values({
      id: WS_B,
      organizationId: ORG,
      slug: "decoy",
      name: "Decoy Workspace"
    });

    const [seeded] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.workspaceId, defaultWorkspaceId(ORG)));
    if (!seeded?.activeVersionId) throw new Error("seeded config missing");
    const [seededVersion] = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, seeded.activeVersionId));
    if (!seededVersion) throw new Error("seeded version missing");
    decoyConfig = structuredClone(seededVersion.config);
    if (!decoyConfig.routes.hard.openai) throw new Error("seeded config missing hard openai route");
    decoyConfig.routes.hard.openai.model = "gpt-decoy-only";

    await fixture.db.insert(requests).values({
      id: "req_decoy",
      organizationId: ORG,
      workspaceId: WS_B,
      userId: "local-user",
      surface: "openai-responses",
      idempotencyKey: "idem_req_decoy",
      requestedModel: "router-auto",
      inputHash: "sha256:req_decoy",
      inputChars: 10,
      status: "completed"
    });
    await fixture.db.insert(agentSessions).values({
      id: "session_decoy",
      organizationId: ORG,
      workspaceId: WS_B,
      userId: "local-user",
      surface: "openai-responses"
    });
    await fixture.db.insert(routingConfigs).values({
      id: "config_decoy",
      organizationId: ORG,
      workspaceId: WS_B,
      name: "Decoy Config",
      slug: "shared-slug",
      status: "active"
    });
    await fixture.db.insert(routingConfigVersions).values({
      id: "config_decoy:v1",
      organizationId: ORG,
      workspaceId: WS_B,
      routingConfigId: "config_decoy",
      version: 1,
      configHash: routingConfigHash(decoyConfig),
      config: decoyConfig,
      status: "active",
      createdByUserId: "local-user",
      activatedAt: new Date()
    });
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
  });

  function scoped() {
    return fixture.persistence.adminQueries.forScope(ORG, defaultWorkspaceId(ORG));
  }

  it("agent request and session reads never see other-workspace rows", async () => {
    const requestList = await scoped().requestsFiltered();
    expect(requestList.data.map((entry: { requestId: string }) => entry.requestId)).not.toContain("req_decoy");

    const sessionList = await scoped().sessionsFiltered();
    expect(sessionList.data.map((entry: { sessionId: string }) => entry.sessionId)).not.toContain("session_decoy");
  });

  it("duplicate-hash propose checks ignore other-workspace versions", async () => {
    expect(await scoped().routingConfigVersionByHash(routingConfigHash(decoyConfig))).toBeNull();
  });

  it("routing config reads stay inside the agent workspace", async () => {
    const configs = await scoped().routingConfigs();
    expect(configs.data.map((entry: { id: string }) => entry.id)).not.toContain("config_decoy");
    expect(await scoped().routingConfigDetail("config_decoy")).toBeNull();
  });

  it("slug staleness checks only consider the proposal workspace", async () => {
    const conversation = await fixture.persistence.consoleAgent.createConversation({
      organizationId: ORG,
      createdByUserId: "local-user"
    });
    const run = await fixture.persistence.consoleAgent.startRun({
      organizationId: ORG,
      conversationId: conversation.id,
      actorUserId: "local-user"
    });
    const config = structuredClone(decoyConfig);
    if (!config.routes.hard.openai) throw new Error("decoy config missing hard openai route");
    config.routes.hard.openai.model = "gpt-default-ws";

    // ws_b already owns "shared-slug"; the default-workspace proposal must not
    // be marked stale by it, and the held create must land in the default ws.
    const proposal = await fixture.persistence.consoleAgentProposals.create({
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      conversationId: conversation.id,
      runId: run.id,
      capabilityKey: "routing_configs.create.v1",
      proposedByUserId: "local-user",
      input: { name: "Shared Slug", config },
      preview: {},
      baseState: { slug: "shared-slug" }
    });
    const resolution = await fixture.persistence.consoleAgentProposals.approve({
      organizationId: ORG,
      proposalId: proposal.id,
      approvedByUserId: "local-user"
    });
    expect(resolution.outcome).toBe("approved");

    const created = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.slug, "shared-slug"));
    expect(created).toHaveLength(2);
    const inDefault = created.find((row) => row.workspaceId === defaultWorkspaceId(ORG));
    expect(inDefault?.organizationId).toBe(ORG);
  });
});
