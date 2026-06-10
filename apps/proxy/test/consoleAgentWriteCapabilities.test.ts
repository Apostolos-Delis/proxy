import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { apiKeys, defaultWorkspaceId, hashApiKey, routingConfigs, routingConfigVersions } from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";

import { registerWriteCapabilities } from "../src/console-agent/capabilities/write.js";
import { CapabilityRegistry } from "../src/console-agent/registry.js";
import { routingConfigSlug } from "../src/persistence/routingConfigAdmin.js";
import { assistantText, assistantToolCall, scriptedStream } from "./consoleAgentTestKit.js";
import {
  adminGet,
  adminPost,
  captureFixture,
  waitFor,
  type PromptTestFixture
} from "./promptTestFixture.js";

const ORG = "org_agent_writes";

// Flagship flow over HTTP: the agent proposes a new config version, the run
// parks awaiting approval, a human approves, the held createVersion executes
// inside the approval transaction, and activation stays a separate proposal.
describe("console agent write capabilities", () => {
  let fixture: PromptTestFixture;
  let seededConfigId = "";
  let draft: RoutingConfig;

  beforeAll(async () => {
    let inner: ReturnType<typeof scriptedStream> | undefined;
    const lazyStream: StreamFn = (model, context, options) => {
      inner ??= scriptedStream([
        assistantToolCall("routing_configs_create_version_v1", {
          configId: seededConfigId,
          config: draft
        }),
        assistantText("unused")
      ]);
      return inner(model, context, options);
    };
    fixture = await captureFixture(ORG, "raw_text", false, { consoleAgentStreamFn: lazyStream });

    const [config] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.organizationId, ORG))
      .limit(1);
    if (!config?.activeVersionId) throw new Error("seeded config missing");
    seededConfigId = config.id;
    const [version] = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, config.activeVersionId));
    if (!version) throw new Error("seeded version missing");
    draft = structuredClone(version.config);
    if (!draft.routes.hard.openai) throw new Error("seeded config missing hard openai route");
    draft.routes.hard.openai.model = "gpt-proposed";
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
  });

  it("proposes a version, parks the run, approves, and executes the held call", async () => {
    const created = await adminPost(fixture, "/admin/console-agent/conversations", {});
    const { conversation } = await created.json();
    const message = await adminPost(
      fixture,
      `/admin/console-agent/conversations/${conversation.id}/messages`,
      { text: "Send hard routes to gpt-proposed." }
    );
    expect(message.status).toBe(202);

    await waitFor(async () => {
      const detail = await adminGet(fixture, `/admin/console-agent/conversations/${conversation.id}`);
      return detail.lastRun?.status === "awaiting_approval";
    });

    const detail = await adminGet(fixture, `/admin/console-agent/conversations/${conversation.id}`);
    expect(detail.proposals).toHaveLength(1);
    const proposal = detail.proposals[0];
    expect(proposal.status).toBe("pending");
    expect(proposal.capabilityKey).toBe("routing_configs.create_version.v1");
    expect(proposal.preview.action).toBe("create_version");
    expect(proposal.preview.diff.changes).toEqual([
      expect.objectContaining({ path: "routes.hard.openai.model", after: "gpt-proposed" })
    ]);

    const versionsBefore = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.routingConfigId, seededConfigId));
    expect(versionsBefore).toHaveLength(1);

    const approve = await adminPost(
      fixture,
      `/admin/console-agent/proposals/${proposal.id}/approve`,
      {}
    );
    expect(approve.status).toBe(200);
    const approved = await approve.json();
    expect(approved.outcome).toBe("approved");

    const versionsAfter = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.routingConfigId, seededConfigId));
    expect(versionsAfter).toHaveLength(2);

    const [config] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, seededConfigId));
    const newVersion = versionsAfter.find((version) => version.id !== config?.activeVersionId);
    expect(newVersion?.config.routes.hard.openai?.model).toBe("gpt-proposed");
    expect(config?.activeVersionId).not.toBe(newVersion?.id);
  });

  it("marks proposals stale when the base state moved and leaves no side effects", async () => {
    const proposals = fixture.persistence.consoleAgentProposals;
    const [config] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, seededConfigId));
    const conversationRow = await fixture.persistence.consoleAgent.createConversation({
      organizationId: ORG,
      createdByUserId: "local-user"
    });
    const run = await fixture.persistence.consoleAgent.startRun({
      organizationId: ORG,
      conversationId: conversationRow.id,
      actorUserId: "local-user"
    });

    const proposal = await proposals.create({
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      conversationId: conversationRow.id,
      runId: run.id,
      capabilityKey: "routing_configs.activate_version.v1",
      proposedByUserId: "local-user",
      input: { configId: seededConfigId, versionId: "irrelevant" },
      preview: {},
      baseState: {
        configId: seededConfigId,
        activeVersionId: "version_that_changed",
        configHash: "stale"
      }
    });

    const resolution = await proposals.approve({
      organizationId: ORG,
      proposalId: proposal.id,
      approvedByUserId: "local-user"
    });
    expect(resolution.outcome).toBe("stale");

    const [after] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, seededConfigId));
    expect(after?.activeVersionId).toBe(config?.activeVersionId);
  });

  it("rejected proposals leave no routing config changes", async () => {
    const detailBefore = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.routingConfigId, seededConfigId));

    const conversationRow = await fixture.persistence.consoleAgent.createConversation({
      organizationId: ORG,
      createdByUserId: "local-user"
    });
    const run = await fixture.persistence.consoleAgent.startRun({
      organizationId: ORG,
      conversationId: conversationRow.id,
      actorUserId: "local-user"
    });
    const proposal = await fixture.persistence.consoleAgentProposals.create({
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      conversationId: conversationRow.id,
      runId: run.id,
      capabilityKey: "routing_configs.create_version.v1",
      proposedByUserId: "local-user",
      input: { configId: seededConfigId, config: draft },
      preview: {},
      baseState: { configId: seededConfigId }
    });
    const rejection = await fixture.persistence.consoleAgentProposals.reject({
      organizationId: ORG,
      proposalId: proposal.id,
      rejectedByUserId: "local-user"
    });
    expect(rejection.outcome).toBe("rejected");

    const detailAfter = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.routingConfigId, seededConfigId));
    expect(detailAfter).toHaveLength(detailBefore.length);
  });

  async function handProposal(
    capabilityKey: string,
    input: Record<string, unknown>,
    baseState: Record<string, unknown>
  ) {
    const conversationRow = await fixture.persistence.consoleAgent.createConversation({
      organizationId: ORG,
      createdByUserId: "local-user"
    });
    const run = await fixture.persistence.consoleAgent.startRun({
      organizationId: ORG,
      conversationId: conversationRow.id,
      actorUserId: "local-user"
    });
    return fixture.persistence.consoleAgentProposals.create({
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      conversationId: conversationRow.id,
      runId: run.id,
      capabilityKey,
      proposedByUserId: "local-user",
      input,
      preview: {},
      baseState
    });
  }

  function approve(proposalId: string) {
    return fixture.persistence.consoleAgentProposals.approve({
      organizationId: ORG,
      proposalId,
      approvedByUserId: "local-user"
    });
  }

  function draftVariant(model: string) {
    const config = structuredClone(draft);
    if (!config.routes.hard.openai) throw new Error("draft missing hard openai route");
    config.routes.hard.openai.model = model;
    return config;
  }

  let createdConfigId = "";

  it("create.v1 executes on approval and lands an active config", async () => {
    const slug = routingConfigSlug("Agent Created Config");
    const proposal = await handProposal(
      "routing_configs.create.v1",
      { name: "Agent Created Config", config: draftVariant("gpt-created") },
      { slug }
    );
    const resolution = await approve(proposal.id);
    expect(resolution.outcome).toBe("approved");

    const [created] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(and(eq(routingConfigs.organizationId, ORG), eq(routingConfigs.slug, slug)));
    expect(created?.status).toBe("active");
    expect(created?.activeVersionId).toBeTruthy();
    createdConfigId = created?.id ?? "";
  });

  it("create.v1 resolves stale when the slug was taken after propose", async () => {
    const [seeded] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, seededConfigId));
    if (!seeded) throw new Error("seeded config missing");

    const proposal = await handProposal(
      "routing_configs.create.v1",
      { name: seeded.name, config: draftVariant("gpt-slug-race") },
      { slug: seeded.slug }
    );
    const resolution = await approve(proposal.id);
    expect(resolution.outcome).toBe("stale");

    const sameSlug = await fixture.db
      .select()
      .from(routingConfigs)
      .where(and(eq(routingConfigs.organizationId, ORG), eq(routingConfigs.slug, seeded.slug)));
    expect(sameSlug).toHaveLength(1);
  });

  it("archive.v1 executes on approval", async () => {
    if (!createdConfigId) throw new Error("create.v1 test must run first");
    const proposal = await handProposal(
      "routing_configs.archive.v1",
      { configId: createdConfigId },
      { configId: createdConfigId }
    );
    const resolution = await approve(proposal.id);
    expect(resolution.outcome).toBe("approved");

    const [archived] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, createdConfigId));
    expect(archived?.status).toBe("archived");
  });

  it("assign_routing_config.v1 executes on approval and detects assignment drift", async () => {
    await fixture.db.insert(apiKeys).values({
      id: "api_key_agent_assign",
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      keyHash: hashApiKey("sk-agent-assign"),
      name: "Agent assignment key",
      scopes: ["proxy"]
    });

    const assignment = await handProposal(
      "api_keys.assign_routing_config.v1",
      { apiKeyId: "api_key_agent_assign", routingConfigId: seededConfigId },
      { apiKeyId: "api_key_agent_assign", routingConfigId: null }
    );
    const approved = await approve(assignment.id);
    expect(approved.outcome).toBe("approved");
    const [assigned] = await fixture.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, "api_key_agent_assign"));
    expect(assigned?.routingConfigId).toBe(seededConfigId);

    const drifted = await handProposal(
      "api_keys.assign_routing_config.v1",
      { apiKeyId: "api_key_agent_assign", routingConfigId: null },
      { apiKeyId: "api_key_agent_assign", routingConfigId: null }
    );
    const stale = await approve(drifted.id);
    expect(stale.outcome).toBe("stale");
    const [after] = await fixture.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, "api_key_agent_assign"));
    expect(after?.routingConfigId).toBe(seededConfigId);
  });

  it("maps 4xx domain conflicts during held execution to stale", async () => {
    const [config] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, seededConfigId));
    const proposal = await handProposal(
      "routing_configs.activate_version.v1",
      { configId: seededConfigId, versionId: "version_missing" },
      {
        configId: seededConfigId,
        activeVersionId: config?.activeVersionId ?? null,
        configHash: "advisory"
      }
    );
    const resolution = await approve(proposal.id);
    expect(resolution.outcome).toBe("stale");

    const [after] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, seededConfigId));
    expect(after?.activeVersionId).toBe(config?.activeVersionId);
  });

  it("rejects duplicate configs and unknown versions at propose time", async () => {
    const registry = registerWriteCapabilities(new CapabilityRegistry(), {
      adminQueries: () => fixture.persistence.adminQueries.forScope(ORG, defaultWorkspaceId(ORG))
    });
    const context = {
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      userId: "local-user",
      conversationId: "conv_propose_checks",
      runId: "run_propose_checks"
    };
    const create = registry.get("routing_configs.create.v1");
    const activate = registry.get("routing_configs.activate_version.v1");
    if (create?.sideEffect !== "write" || activate?.sideEffect !== "write") {
      throw new Error("write capabilities missing");
    }

    const [config] = await fixture.db
      .select()
      .from(routingConfigs)
      .where(eq(routingConfigs.id, seededConfigId));
    const [activeVersion] = await fixture.db
      .select()
      .from(routingConfigVersions)
      .where(eq(routingConfigVersions.id, config?.activeVersionId ?? ""));
    if (!activeVersion) throw new Error("active version missing");

    await expect(
      create.prepareProposal(context, { name: "Duplicate Config", config: activeVersion.config })
    ).rejects.toThrow(/identical to existing version/);

    await expect(
      activate.prepareProposal(context, { configId: seededConfigId, versionId: "version_unknown" })
    ).rejects.toThrow(/does not exist/);

    const prepared = await create.prepareProposal(context, {
      name: "  Fancy Routing Name  ",
      config: draftVariant("gpt-slug-preview")
    });
    expect(prepared.preview.slug).toBe("fancy-routing-name");
    expect(prepared.baseState?.slug).toBe("fancy-routing-name");
  });
});
