import { afterEach, describe, expect, it } from "vitest";

import { promptArtifacts } from "@proxy/db";
import { eq } from "drizzle-orm";

import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("prompt retention admin APIs", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("configures prompt retention and redacts expired raw artifacts", async () => {
    const fixture = await setup("org_prompt_retention");

    const settings = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `mutation {
        configurePromptCapture(promptCaptureMode: "raw_text", retentionDays: 1) {
          organizationId
          promptCaptureMode
          retentionDays
        }
      }`
    )).data?.configurePromptCapture;
    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "coding-auto",
        input: "Expire this raw prompt.",
        stream: true
      })
    });
    await response.text();

    const [artifact] = await fixture.db
      .select()
      .from(promptArtifacts)
      .where(eq(promptArtifacts.kind, "user_message"));
    const originalHash = artifact.contentHash;
    await fixture.db
      .update(promptArtifacts)
      .set({ expiresAt: new Date("2026-06-07T00:00:00.000Z") })
      .where(eq(promptArtifacts.id, artifact.id));
    const redaction = await fixture.persistence.promptArtifacts.redactExpired(
      "org_prompt_retention",
      new Date("2026-06-08T00:00:00.000Z")
    );
    const detail = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query Prompt($artifactId: ID!) {
        prompt(artifactId: $artifactId) {
          artifact { storageMode rawText redactedText contentHash metadata }
        }
      }`,
      { artifactId: artifact.id }
    )).data?.prompt;
    const usage = (await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      "query { usage(groupBy: logical_model) { totals { requestCount } } }"
    )).data?.usage;

    expect(settings).toEqual({
      organizationId: "org_prompt_retention",
      promptCaptureMode: "raw_text",
      retentionDays: 1
    });
    expect(response.status).toBe(200);
    expect(artifact.rawText).toBe("Expire this raw prompt.");
    expect(artifact.expiresAt).toBeInstanceOf(Date);
    expect(redaction).toEqual({ redactedCount: 1 });
    expect(detail.artifact).toEqual(expect.objectContaining({
      storageMode: "redacted",
      rawText: null,
      redactedText: "Redacted by retention policy.",
      contentHash: originalHash
    }));
    expect(detail.artifact.metadata).toEqual(expect.objectContaining({
      chars: "Expire this raw prompt.".length
    }));
    expect(usage.totals.requestCount).toBeGreaterThan(0);
  });

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
