import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeys,
  events,
  hashApiKey,
  routingConfigs,
  routingConfigVersions
} from "@prompt-proxy/db";
import { seedDatabase, seedOptionsFromEnv } from "@prompt-proxy/db/seed";

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("routing config runtime resolution", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("rejects invalid active configs before classifier spend", async () => {
    const organizationId = "org_invalid_runtime_config";
    activeFixture = await captureFixture(organizationId);
    await seedDatabase(activeFixture.db, seedOptionsFromEnv({
      DEFAULT_ORGANIZATION_ID: organizationId,
      SEED_USER_ID: "local-user",
      PROMPT_PROXY_TOKEN: "proxy-token"
    }));
    await activeFixture.db
      .update(routingConfigVersions)
      .set({ config: { schemaVersion: 1 } as never })
      .where(eq(routingConfigVersions.id, `${organizationId}:routing-config:default:v1`));

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: true
      })
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("routing_config_invalid");
    expect(activeFixture.openai.records).toHaveLength(0);
  });

  it("uses API-key routing config classifier settings", async () => {
    const organizationId = "org_config_classifier";
    activeFixture = await captureFixture(organizationId);
    const assigned = await assignClassifierConfig(activeFixture, organizationId, {
      secret: "assigned-classifier-token",
      model: "route-classifier-alt",
      instructions: "Custom classifier instructions for assigned API keys.",
      maxAttempts: 1,
      allowRedactedExcerpt: true
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer assigned-classifier-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: true
      })
    });
    await response.text();

    const classifierCall = activeFixture.openai.records.find((record) =>
      record.body.model === "route-classifier-alt"
    );
    const classifierInput = JSON.parse(classifierCall?.body.input ?? "{}");
    const eventRows = await activeFixture.db.select().from(events);
    const classification = eventRows.find((event) => event.eventType === "routing.classification_recorded");
    const decision = eventRows.find((event) => event.eventType === "routing.decision_recorded");

    expect(response.status).toBe(200);
    expect(classifierCall).toBeTruthy();
    expect(classifierCall?.body.instructions).toBe("Custom classifier instructions for assigned API keys.");
    expect(classifierCall?.body.text.format.name).toBe(assigned.config.classifier.structuredOutput.schemaName);
    expect(classifierInput.content_mode).toBe("redacted_excerpt");
    expect(classification?.payload).toEqual(expect.objectContaining({
      model: "route-classifier-alt",
      routingConfig: expect.objectContaining({
        configId: assigned.configId,
        versionId: assigned.versionId,
        configHash: assigned.configHash
      })
    }));
    expect(decision?.payload).toEqual(expect.objectContaining({
      routingConfig: expect.objectContaining({
        configId: assigned.configId,
        versionId: assigned.versionId,
        configHash: assigned.configHash
      }),
      classifier: expect.objectContaining({
        provider: "openai",
        model: "route-classifier-alt",
        routingConfigVersionId: assigned.versionId,
        routingConfigHash: assigned.configHash
      })
    }));
  });

  it("uses API-key routing config classifier retry limits", async () => {
    const organizationId = "org_config_classifier_retry";
    activeFixture = await captureFixture(organizationId, "raw_text", false, {
      openAIOptions: { invalidClassifier: true }
    });
    await assignClassifierConfig(activeFixture, organizationId, {
      secret: "retry-classifier-token",
      model: "route-classifier-retry-once",
      instructions: "Retry once for assigned API keys.",
      maxAttempts: 1,
      allowRedactedExcerpt: false
    });

    const response = await fetch(`${activeFixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer retry-classifier-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "debug this failing test",
        stream: false
      })
    });
    await response.text();

    expect(response.status).toBe(500);
    expect(activeFixture.openai.records.filter((record) =>
      record.body.model === "route-classifier-retry-once"
    )).toHaveLength(1);
  });
});

async function assignClassifierConfig(
  fixture: PromptTestFixture,
  organizationId: string,
  input: {
    secret: string;
    model: string;
    instructions: string;
    maxAttempts: number;
    allowRedactedExcerpt: boolean;
  }
) {
  const configId = `${organizationId}:routing-config:classifier`;
  const versionId = `${configId}:v1`;
  const configHash = "sha256:classifier-config";
  const defaultVersion = await activeVersion(fixture, `${organizationId}:routing-config:default:v1`);
  const config = {
    ...defaultVersion.config,
    displayName: "Assigned classifier router",
    classifier: {
      ...defaultVersion.config.classifier,
      model: input.model,
      instructions: input.instructions,
      maxAttempts: input.maxAttempts,
      allowRedactedExcerpt: input.allowRedactedExcerpt
    }
  };

  await fixture.db.insert(routingConfigs).values({
    id: configId,
    organizationId,
    name: "Assigned classifier config",
    slug: "classifier",
    status: "active"
  });
  await fixture.db.insert(routingConfigVersions).values({
    id: versionId,
    organizationId,
    routingConfigId: configId,
    version: 1,
    configHash,
    config,
    status: "active",
    createdByUserId: "local-user",
    activatedAt: new Date("2026-06-08T00:00:00.000Z")
  });
  await fixture.db
    .update(routingConfigs)
    .set({ activeVersionId: versionId })
    .where(eq(routingConfigs.id, configId));
  await fixture.db.insert(apiKeys).values({
    id: "api_key_classifier",
    organizationId,
    keyHash: hashApiKey(input.secret),
    name: "Assigned classifier key",
    routingConfigId: configId,
    scopes: ["proxy"]
  });

  return {
    configId,
    versionId,
    configHash,
    config
  };
}

async function activeVersion(
  fixture: PromptTestFixture,
  versionId: string
) {
  const [version] = await fixture.db
    .select()
    .from(routingConfigVersions)
    .where(eq(routingConfigVersions.id, versionId))
    .limit(1);
  expect(version).toBeTruthy();
  return version!;
}
