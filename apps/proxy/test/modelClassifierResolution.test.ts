import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPgliteDatabase,
  defaultWorkspaceId,
  deploymentWireBindings,
  logicalModels,
  logicalModelTargets,
  modelDeployments
} from "@proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@proxy/db/seed";
import type { GatewayModelCapabilities } from "@proxy/schema";
import type {
  LogicalModelClassificationInput,
  LogicalModelClassifier
} from "../src/classifier.js";
import {
  ModelResolutionService,
  type ModelResolutionDenialCode,
  type ModelResolutionResult
} from "../src/persistence/modelResolution.js";

describe("classifier logical model resolution", () => {
  let client: PGlite | undefined;

  afterEach(async () => {
    await client?.close();
  });

  it("selects only from enabled compatible targets and returns decision evidence", async () => {
    const calls: LogicalModelClassificationInput[] = [];
    const classifier: LogicalModelClassifier = {
      async classifyLogicalModel(input) {
        calls.push(input);
        return {
          targetId: input.request.candidates[0]!.targetId,
          reasonCodes: ["capability_match"],
          confidence: 0.85,
          attempts: 1
        };
      }
    };
    const fixture = await setup("org_classifier_bounded", classifier);
    client = fixture.client;
    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const logicalModelId = `${workspaceId}:logical-model:coding-auto`;
    const [disabledTarget] = await fixture.db
      .select({ id: logicalModelTargets.id })
      .from(logicalModelTargets)
      .where(eq(logicalModelTargets.logicalModelId, logicalModelId))
      .limit(1);
    expect(disabledTarget).toBeTruthy();
    await fixture.db
      .update(logicalModelTargets)
      .set({ enabled: false })
      .where(eq(logicalModelTargets.id, disabledTarget!.id));

    const result = await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: "coding-auto",
      classificationFeatures: { hasTools: true, extractedHints: ["high_risk"] }
    }));

    expect(result).toEqual(expect.objectContaining({
      outcome: "resolved",
      logicalModelSlug: "coding-auto",
      routerDecisionId: "decision_test",
      routerDecision: expect.objectContaining({
        kind: "classifier",
        selectedTargetId: calls[0]?.request.candidates[0]?.targetId,
        attempts: 1,
        reasonCodes: ["capability_match"],
        confidence: 0.85
      })
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.context).toEqual({
      requestedModel: "coding-auto",
      operationId: "text.generate",
      hasTools: true,
      extractedHints: ["high_risk"]
    });
    expect(calls[0]?.request.candidates.length).toBeGreaterThan(1);
    expect(calls[0]?.request.candidates.some((candidate) => candidate.targetId === disabledTarget!.id)).toBe(false);
    expect(calls[0]?.request.candidates.every((candidate) =>
      Object.keys(candidate).sort().join(",") === "capabilities,targetId"
    )).toBe(true);
    expect(calls[0]?.request.candidates.every((candidate) =>
      Object.keys(candidate.capabilities).every((key) => [
        "contextWindow",
        "efforts",
        "image",
        "images",
        "maxOutputTokens",
        "modalities",
        "reasoning",
        "streaming",
        "toolCall",
        "tools"
      ].includes(key))
    )).toBe(true);
  });

  it("filters classifier candidates by explicit capability constraints", async () => {
    const calls: LogicalModelClassificationInput[] = [];
    const classifier: LogicalModelClassifier = {
      async classifyLogicalModel(input) {
        calls.push(input);
        return {
          targetId: input.request.candidates[0]!.targetId,
          reasonCodes: ["capability_match"],
          confidence: 1,
          attempts: 1
        };
      }
    };
    const fixture = await setup("org_classifier_capabilities", classifier);
    client = fixture.client;
    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const logicalModelId = `${workspaceId}:logical-model:coding-auto`;
    const targetRows = await fixture.db
      .select({
        targetId: logicalModelTargets.id,
        deploymentId: modelDeployments.id
      })
      .from(logicalModelTargets)
      .innerJoin(modelDeployments, eq(modelDeployments.id, logicalModelTargets.deploymentId))
      .where(eq(logicalModelTargets.logicalModelId, logicalModelId));
    const supportedTarget = targetRows[0]!;
    const cases: Array<{
      unsupported: GatewayModelCapabilities;
      input: Partial<Parameters<ModelResolutionService["resolve"]>[0]>;
    }> = [
      {
        unsupported: { tools: false },
        input: { classificationFeatures: { hasTools: true } }
      },
      {
        unsupported: { modalities: ["text"] },
        input: { classificationFeatures: { hasImages: true } }
      },
      {
        unsupported: { modalities: ["image"] },
        input: {}
      },
      {
        unsupported: { contextWindow: 100 },
        input: { classificationFeatures: { estimatedInputTokens: 150 } }
      },
      {
        unsupported: { maxOutputTokens: 100 },
        input: { parameters: { max_output_tokens: 150 } }
      },
      {
        unsupported: { streaming: false },
        input: { isStreaming: true }
      }
    ];

    for (const testCase of cases) {
      for (const target of targetRows) {
        await fixture.db
          .update(modelDeployments)
          .set({
            capabilities: target.targetId === supportedTarget.targetId
              ? {}
              : testCase.unsupported
          })
          .where(eq(modelDeployments.id, target.deploymentId));
      }
      expect((await fixture.resolver.resolve(resolveInput(fixture.organizationId, testCase.input))).outcome)
        .toBe("resolved");
      expect(calls.at(-1)?.request.candidates.map((candidate) => candidate.targetId))
        .toEqual([supportedTarget.targetId]);
    }

    for (const target of targetRows) {
      await fixture.db
        .update(modelDeployments)
        .set({ capabilities: {} })
        .where(eq(modelDeployments.id, target.deploymentId));
    }
    expect((await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      classificationFeatures: { estimatedInputTokens: 100, hasTools: true, hasImages: true },
      parameters: { max_output_tokens: 100 },
      isStreaming: true
    }))).outcome).toBe("resolved");
    expect(calls.at(-1)?.request.candidates).toHaveLength(targetRows.length);
  });

  it("rejects a classifier selection outside the economy target set", async () => {
    const calls: LogicalModelClassificationInput[] = [];
    const classifier: LogicalModelClassifier = {
      async classifyLogicalModel(input) {
        calls.push(input);
        return {
          targetId: "target_frontier_outside_set",
          reasonCodes: ["attempted_escape"],
          confidence: 1,
          attempts: 1
        };
      }
    };
    const fixture = await setup("org_classifier_economy", classifier);
    client = fixture.client;

    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: "economy-auto"
    })), "classifier_failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.candidates).toHaveLength(2);
    expect(await targetModels(fixture, calls[0]!.request.candidates.map((candidate) => candidate.targetId))).toEqual([
      "claude-haiku-4-5",
      "gpt-5.4-mini"
    ]);
  });

  it("fails closed when classifier execution fails", async () => {
    let calls = 0;
    const classifier: LogicalModelClassifier = {
      async classifyLogicalModel() {
        calls += 1;
        throw new Error("invalid structured output after retries");
      }
    };
    const fixture = await setup("org_classifier_failure", classifier);
    client = fixture.client;

    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: "coding-auto",
      classificationFeatures: { rawPrompt: "secret" } as never
    })), "classification_context_invalid");
    expect(calls).toBe(0);

    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const logicalModelId = `${workspaceId}:logical-model:coding-auto`;
    const oversizedSlug = "x".repeat(513);
    await fixture.db
      .update(logicalModels)
      .set({ slug: oversizedSlug })
      .where(eq(logicalModels.id, logicalModelId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: oversizedSlug
    })), "classification_context_invalid");
    expect(calls).toBe(0);
    await fixture.db
      .update(logicalModels)
      .set({ slug: "coding-auto" })
      .where(eq(logicalModels.id, logicalModelId));

    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: "coding-auto"
    })), "classifier_failed");
    expect(calls).toBe(1);
  });

  it("rejects disabled, wire-incompatible, cross-scope, and recursive classifier deployments", async () => {
    let calls = 0;
    const classifier: LogicalModelClassifier = {
      async classifyLogicalModel(input) {
        calls += 1;
        return {
          targetId: input.request.candidates[0]!.targetId,
          reasonCodes: ["selected"],
          confidence: 1,
          attempts: 1
        };
      }
    };
    const fixture = await setup("org_classifier_target", classifier);
    client = fixture.client;
    const workspaceId = defaultWorkspaceId(fixture.organizationId);
    const logicalModelId = `${workspaceId}:logical-model:coding-auto`;
    const classifierDeploymentId = `${workspaceId}:deployment:openai:gpt-5-nano-2025-08-07`;

    await fixture.db
      .update(modelDeployments)
      .set({ status: "disabled" })
      .where(eq(modelDeployments.id, classifierDeploymentId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: "coding-auto"
    })), "classifier_target_unavailable");
    await fixture.db
      .update(modelDeployments)
      .set({ status: "active" })
      .where(eq(modelDeployments.id, classifierDeploymentId));

    await fixture.db
      .update(deploymentWireBindings)
      .set({ enabled: false })
      .where(and(
        eq(deploymentWireBindings.deploymentId, classifierDeploymentId),
        eq(deploymentWireBindings.apiWireId, "openai-responses")
      ));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: "coding-auto"
    })), "classifier_target_unavailable");
    await fixture.db
      .update(deploymentWireBindings)
      .set({ enabled: true })
      .where(eq(deploymentWireBindings.deploymentId, classifierDeploymentId));

    await seedDatabase(fixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: "org_classifier_other",
      SEED_USER_ID: "user_classifier_other",
      SEED_USER_EMAIL: "classifier-other@example.com",
      PROXY_TOKEN: "token_classifier_other"
    }));
    await fixture.db
      .update(logicalModels)
      .set({
        routerConfig: classifierConfig(`${defaultWorkspaceId("org_classifier_other")}:deployment:openai:gpt-5-nano-2025-08-07`)
      })
      .where(eq(logicalModels.id, logicalModelId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: "coding-auto"
    })), "classifier_target_unavailable");

    await fixture.db
      .update(logicalModels)
      .set({ routerConfig: classifierConfig(logicalModelId) })
      .where(eq(logicalModels.id, logicalModelId));
    expectDenial(await fixture.resolver.resolve(resolveInput(fixture.organizationId, {
      requestedModel: "coding-auto"
    })), "router_config_invalid");
    expect(calls).toBe(0);
  });
});

async function setup(organizationId: string, classifier: LogicalModelClassifier) {
  const client = await migratedClient();
  const db = createPgliteDatabase(client);
  await seedDatabase(db, seedOptionsFromEnv({
    DEFAULT_ORGANIZATION_ID: organizationId,
    SEED_USER_ID: `user_${organizationId}`,
    PROXY_TOKEN: `token_${organizationId}`
  }));
  return {
    client,
    db,
    resolver: new ModelResolutionService(db, {
      classifier,
      decisionId: () => "decision_test"
    }),
    organizationId
  };
}

async function migratedClient() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  return client;
}

function resolveInput(
  organizationId: string,
  overrides: Partial<Parameters<ModelResolutionService["resolve"]>[0]> = {}
) {
  return {
    organizationId,
    workspaceId: defaultWorkspaceId(organizationId),
    apiKeyId: `${organizationId}:api-key:default`,
    ingressWireId: "anthropic-messages" as const,
    operationId: "text.generate" as const,
    requestedModel: "coding-auto",
    ...overrides
  };
}

function classifierConfig(classifierDeploymentId: string) {
  return {
    classifierDeploymentId,
    instructions: "Choose one eligible target.",
    timeoutMs: 10_000,
    maxAttempts: 2
  };
}

async function targetModels(
  fixture: Awaited<ReturnType<typeof setup>>,
  targetIds: string[]
) {
  const rows = await fixture.db
    .select({ targetId: logicalModelTargets.id, model: modelDeployments.upstreamModelId })
    .from(logicalModelTargets)
    .innerJoin(modelDeployments, eq(modelDeployments.id, logicalModelTargets.deploymentId));
  const byTarget = new Map(rows.map((row) => [row.targetId, row.model]));
  return targetIds.map((targetId) => byTarget.get(targetId)!).sort();
}

function expectDenial(result: ModelResolutionResult, code: ModelResolutionDenialCode) {
  expect(result).toEqual(expect.objectContaining({ outcome: "denied", code }));
}
