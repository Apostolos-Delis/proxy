import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { routingConfigVersions } from "@prompt-proxy/db";
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
});
