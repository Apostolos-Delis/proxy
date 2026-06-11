import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTransactionalDatabase, defaultWorkspaceId, routingConfigs, routingConfigVersions } from "@prompt-proxy/db";
import type { RoutingConfig } from "@prompt-proxy/schema";

import { registerPreviewCapability } from "../src/console-agent/capabilities/preview.js";
import { CapabilityPolicy } from "../src/console-agent/policy.js";
import { CapabilityRegistry, type CapabilityContext } from "../src/console-agent/registry.js";
import { ConsoleAgentStore } from "../src/persistence/consoleAgentStore.js";
import { executed } from "./consoleAgentTestKit.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const ORG = "org_agent_preview";

const context: CapabilityContext = {
  organizationId: ORG,
  workspaceId: defaultWorkspaceId(ORG),
  userId: "local-user",
  conversationId: "conv_preview",
  runId: "run_preview"
};

describe("routing config preview capability", () => {
  let fixture: PromptTestFixture;
  let policy: CapabilityPolicy;
  let seededConfigId: string;
  let seededConfig: RoutingConfig;
  let seededVersionId: string;
  let seededHash: string;

  beforeAll(async () => {
    fixture = await captureFixture(ORG);
    const registry = registerPreviewCapability(new CapabilityRegistry(), {
      adminQueries: () => fixture.persistence.adminQueries.forScope(ORG, defaultWorkspaceId(ORG))
    });
    policy = new CapabilityPolicy(
      registry,
      new ConsoleAgentStore(createTransactionalDatabase(fixture.db), fixture.db)
    );

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
    seededConfig = version.config;
    seededVersionId = version.id;
    seededHash = version.configHash;
  }, 60_000);

  afterAll(async () => {
    await fixture.close();
  });

  it("returns actionable validation issues for invalid drafts", async () => {
    const output = executed(
      await policy.call(context, "routing_configs.preview.v1", {
        draft: { name: "broken" }
      })
    );
    expect(output.valid).toBe(false);
    const issues = output.issues as Array<{ path: string; message: string }>;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => typeof issue.path === "string" && issue.message.length > 0)).toBe(true);
  });

  it("normalizes a valid draft and diffs against the active version", async () => {
    const draft = structuredClone(seededConfig) as RoutingConfig;
    if (!draft.routes.hard.openai) throw new Error("seeded config missing hard openai route");
    draft.routes.hard.openai.model = "gpt-experimental";

    const output = executed(
      await policy.call(context, "routing_configs.preview.v1", {
        configId: seededConfigId,
        draft
      })
    );

    expect(output.valid).toBe(true);
    expect(typeof output.draftHash).toBe("string");
    expect(output.baseState).toEqual({
      configId: seededConfigId,
      activeVersionId: seededVersionId,
      configHash: seededHash
    });
    const diff = output.diff as { changes: Array<{ path: string; before: unknown; after: unknown }> };
    expect(diff.changes).toEqual([
      expect.objectContaining({
        path: "routes.hard.openai.model",
        after: "gpt-experimental"
      })
    ]);
  });

  it("handles the new-config case without a diff", async () => {
    const output = executed(
      await policy.call(context, "routing_configs.preview.v1", { draft: seededConfig })
    );
    expect(output.valid).toBe(true);
    expect(output.diff).toBeNull();
    expect(output.baseState).toEqual({ configId: null, activeVersionId: null, configHash: null });
  });

  it("handles configs without an active version", async () => {
    await fixture.db.insert(routingConfigs).values({
      id: "config_no_active",
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      name: "No Active",
      slug: "no-active"
    });
    const output = executed(
      await policy.call(context, "routing_configs.preview.v1", {
        configId: "config_no_active",
        draft: seededConfig
      })
    );
    expect(output.valid).toBe(true);
    expect(output.diff).toBeNull();
    expect(output.baseState).toEqual({
      configId: "config_no_active",
      activeVersionId: null,
      configHash: null
    });
  });

  it("reports unknown configs as a validation issue", async () => {
    const output = executed(
      await policy.call(context, "routing_configs.preview.v1", {
        configId: "config_missing",
        draft: seededConfig
      })
    );
    expect(output.valid).toBe(false);
    expect(output.issues).toEqual([
      expect.objectContaining({ path: "configId" })
    ]);
  });
});
