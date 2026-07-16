import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeys,
  compressionReceipts,
  defaultWorkspaceId,
  events as eventTable,
  hashApiKey,
  promptAccessAudit,
  promptArtifacts,
  workspaces
} from "@proxy/db";
import { defaultCompressionPolicy } from "@proxy/schema";

import { sha256 } from "../src/util.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const verbose = JSON.stringify(
  { items: Array.from({ length: 120 }, (_, index) => ({ id: index, title: `issue ${index}`, note: null })) },
  null,
  2
);

describe("compression retrieval resolver", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  it("returns original content for the same scoped receipt and hides unauthorized scopes", async () => {
    const organizationId = "org_compression_retrieval_valid";
    const setup = await setupCompressionReceipt(organizationId);
    fixture = setup.fixture;

    const result = await setup.fixture.persistence.compressionRetrieval.resolve(setup.input);

    expect(result).toMatchObject({
      ok: true,
      retrievalId: setup.input.retrievalId,
      content: verbose,
      metadata: expect.objectContaining({
        receiptId: setup.receipt.id,
        requestId: setup.receipt.requestId,
        surface: "anthropic-messages",
        blockPath: "messages.2.content.0",
        toolName: "mcp__linear__list_issues",
        ruleId: "json-array-compaction",
        originalSha256: sha256(verbose)
      })
    });

    await setup.fixture.db.insert(workspaces).values({
      id: `${organizationId}:workspace:other`,
      organizationId,
      slug: "other",
      name: "Other"
    });

    await expect(setup.fixture.persistence.compressionRetrieval.resolve({
      ...setup.input,
      workspaceId: `${organizationId}:workspace:other`
    })).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(setup.fixture.persistence.compressionRetrieval.resolve({
      ...setup.input,
      organizationId: `${organizationId}-sandbox`,
      workspaceId: defaultWorkspaceId(`${organizationId}-sandbox`)
    })).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(setup.fixture.persistence.compressionRetrieval.resolve({
      ...setup.input,
      apiKeyId: `${organizationId}:api-key:other`
    })).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("exposes an API-key authenticated endpoint without internal ids", async () => {
    const organizationId = "org_compression_retrieval_endpoint";
    const setup = await setupCompressionReceipt(organizationId);
    fixture = setup.fixture;

    const response = await retrieve(setup.fixture.proxyUrl, "proxy-token", {
      retrievalId: setup.input.retrievalId,
      query: "issue 12"
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      retrievalId: setup.input.retrievalId,
      content: verbose,
      queryApplied: false,
      metadata: expect.objectContaining({
        surface: "anthropic-messages",
        blockPath: "messages.2.content.0",
        toolName: "mcp__linear__list_issues",
        ruleId: "json-array-compaction",
        originalSha256: sha256(verbose)
      })
    });
    expect(body.metadata).not.toHaveProperty("receiptId");
    expect(body.metadata).not.toHaveProperty("requestId");
    expect(body.metadata).not.toHaveProperty("originalArtifactId");

    const auditRows = await setup.fixture.db.select().from(promptAccessAudit);
    const eventRows = await setup.fixture.db.select().from(eventTable);
    const retrieved = eventRows.find((event) => event.eventType === "compression.retrieved");
    expect(auditRows).toEqual([
      expect.objectContaining({
        organizationId,
        workspaceId: defaultWorkspaceId(organizationId),
        artifactId: setup.receipt.originalArtifactId,
        requestId: setup.receipt.requestId,
        userId: "local-user",
        accessPath: "/v1/compression/retrieve"
      })
    ]);
    expect(retrieved?.payload).toMatchObject({
      retrievalId: setup.input.retrievalId,
      receiptId: setup.receipt.id,
      requestId: setup.receipt.requestId,
      toolName: "mcp__linear__list_issues",
      status: "retrieved",
      receiptStatus: "measured",
      failureReason: null
    });
    expect(JSON.stringify(retrieved?.payload)).not.toContain(verbose.slice(0, 50));
  });

  it("exposes retrieval state and artifact expiry through admin receipts", async () => {
    const organizationId = "org_compression_retrieval_admin_receipts";
    const setup = await setupCompressionReceipt(organizationId);
    fixture = setup.fixture;
    const expiresAt = "2026-07-01T00:00:00.000Z";
    await setup.fixture.db
      .update(promptArtifacts)
      .set({ expiresAt: new Date(expiresAt) })
      .where(eq(promptArtifacts.id, setup.receipt.originalArtifactId));

    const detail = await adminGql(
      setup.fixture.proxyUrl,
      setup.fixture.adminHeaders,
      `query ReceiptRetrievalState($requestId: ID!) {
        request(requestId: $requestId) {
          compressionReceipts {
            retrievalId
            retrievalAvailable
            retrievalMarker
            originalArtifactId
            originalArtifactExpiresAt
            compressedArtifactId
            compressedArtifactExpiresAt
          }
        }
      }`,
      { requestId: setup.receipt.requestId }
    );

    expect(detail.errors).toBeUndefined();
    expect(detail.data?.request?.compressionReceipts).toEqual([
      expect.objectContaining({
        retrievalId: setup.input.retrievalId,
        retrievalAvailable: true,
        retrievalMarker: setup.receipt.retrievalMarker,
        originalArtifactId: setup.receipt.originalArtifactId,
        originalArtifactExpiresAt: expiresAt,
        compressedArtifactId: setup.receipt.compressedArtifactId,
        compressedArtifactExpiresAt: expect.any(String)
      })
    ]);
  });

  it("returns stable endpoint errors for invalid, unauthorized, and unavailable retrievals", async () => {
    const organizationId = "org_compression_retrieval_endpoint_errors";
    const setup = await setupCompressionReceipt(organizationId);
    fixture = setup.fixture;

    const unauthenticated = await fetch(`${setup.fixture.proxyUrl}/v1/compression/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retrievalId: setup.input.retrievalId })
    });
    expect(unauthenticated.status).toBe(401);

    const invalid = await retrieve(setup.fixture.proxyUrl, "proxy-token", {
      retrievalId: setup.receipt.id
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_request" });

    await setup.fixture.db.insert(apiKeys).values({
      id: `${organizationId}:api-key:other`,
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      userId: "local-user",
      keyHash: hashApiKey("other-token"),
      name: "Other key",
      accessProfileId: `${defaultWorkspaceId(organizationId)}:access-profile:opendoor-engineer`
    });
    const otherKey = await retrieve(setup.fixture.proxyUrl, "other-token", {
      retrievalId: setup.input.retrievalId
    });
    expect(otherKey.status).toBe(404);
    await expect(otherKey.json()).resolves.toMatchObject({ error: "not_found" });

    await setup.fixture.db
      .update(promptArtifacts)
      .set({ storageMode: "hash_only", rawText: null })
      .where(eq(promptArtifacts.id, setup.receipt.originalArtifactId));
    const unavailable = await retrieve(setup.fixture.proxyUrl, "proxy-token", {
      retrievalId: setup.input.retrievalId
    });
    expect(unavailable.status).toBe(409);
    await expect(unavailable.json()).resolves.toMatchObject({ error: "artifact_unavailable" });

    await setup.fixture.db
      .update(promptArtifacts)
      .set({ storageMode: "raw_text", rawText: verbose, contentHash: sha256(verbose), expiresAt: new Date("2026-06-01T00:00:00.000Z") })
      .where(eq(promptArtifacts.id, setup.receipt.originalArtifactId));
    const expired = await retrieve(setup.fixture.proxyUrl, "proxy-token", {
      retrievalId: setup.input.retrievalId
    });
    expect(expired.status).toBe(410);
    await expect(expired.json()).resolves.toMatchObject({ error: "artifact_expired" });

    const auditRows = await setup.fixture.db.select().from(promptAccessAudit);
    const eventRows = await setup.fixture.db.select().from(eventTable);
    const failures = eventRows.filter((event) => event.eventType === "compression.retrieval_failed");
    expect(auditRows).toHaveLength(0);
    expect(failures.map((event) => event.payload.failureReason)).toEqual([
      "artifact_unavailable",
      "artifact_expired"
    ]);
    expect(failures.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        retrievalId: setup.input.retrievalId,
        receiptId: setup.receipt.id,
        requestId: setup.receipt.requestId,
        toolName: "mcp__linear__list_issues",
        status: "failed"
      }),
      expect.objectContaining({
        retrievalId: setup.input.retrievalId,
        receiptId: setup.receipt.id,
        requestId: setup.receipt.requestId,
        toolName: "mcp__linear__list_issues",
        status: "failed"
      })
    ]);
    for (const failure of failures) {
      expect(JSON.stringify(failure.payload)).not.toContain(verbose.slice(0, 50));
    }
  });

  it("returns typed failures for unavailable artifacts without raw content", async () => {
    const organizationId = "org_compression_retrieval_failures";
    const setup = await setupCompressionReceipt(organizationId);
    fixture = setup.fixture;

    await setup.fixture.db
      .update(promptArtifacts)
      .set({ storageMode: "hash_only", rawText: null })
      .where(eq(promptArtifacts.id, setup.receipt.originalArtifactId));
    await expect(setup.fixture.persistence.compressionRetrieval.resolve(setup.input))
      .resolves.toMatchObject({ ok: false, reason: "artifact_unavailable" });

    await setup.fixture.db
      .update(promptArtifacts)
      .set({ storageMode: "raw_text", rawText: verbose, contentHash: sha256(verbose), expiresAt: new Date("2026-06-01T00:00:00.000Z") })
      .where(eq(promptArtifacts.id, setup.receipt.originalArtifactId));
    await expect(setup.fixture.persistence.compressionRetrieval.resolve({
      ...setup.input,
      now: new Date("2026-06-02T00:00:00.000Z")
    })).resolves.toMatchObject({ ok: false, reason: "artifact_expired" });

    await setup.fixture.db
      .update(promptArtifacts)
      .set({ expiresAt: new Date("2026-06-03T00:00:00.000Z"), contentHash: sha256("tampered") })
      .where(eq(promptArtifacts.id, setup.receipt.originalArtifactId));
    await expect(setup.fixture.persistence.compressionRetrieval.resolve({
      ...setup.input,
      now: new Date("2026-06-02T00:00:00.000Z")
    })).resolves.toMatchObject({ ok: false, reason: "hash_mismatch" });

    await setup.fixture.db
      .update(compressionReceipts)
      .set({ originalArtifactId: null })
      .where(eq(compressionReceipts.id, setup.receipt.id));
    await expect(setup.fixture.persistence.compressionRetrieval.resolve(setup.input))
      .resolves.toMatchObject({ ok: false, reason: "artifact_missing" });
  });
});

async function setupCompressionReceipt(organizationId: string) {
  const fixture = await captureFixture(organizationId);
  await fixture.persistence.organizationSettings.setToolResultCompressionPolicy(
    organizationId,
    {
      ...defaultCompressionPolicy(),
      mode: "measure_only",
      minOriginalBytes: 512,
      minSavingsTokens: 0,
      storeOriginalArtifact: true,
      storeCompressedArtifact: true
    }
  );

  await fetch(`${fixture.proxyUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable",
      max_tokens: 256,
      messages: [
        { role: "user", content: "list the open issues" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
      ]
    })
  });

  const [receipt] = await fixture.db.select().from(compressionReceipts);
  const retrievalId = receipt?.retrievalId;
  const originalArtifactId = receipt?.originalArtifactId;
  if (!receipt || !retrievalId || !originalArtifactId) {
    await fixture.close();
    throw new Error("missing compression retrieval fixture receipt");
  }

  return {
    fixture,
    receipt: { ...receipt, retrievalId, originalArtifactId },
    input: {
      organizationId,
      workspaceId: defaultWorkspaceId(organizationId),
      apiKeyId: `${organizationId}:api-key:default`,
      retrievalId
    }
  };
}

function retrieve(proxyUrl: string, token: string, body: unknown) {
  return fetch(`${proxyUrl}/v1/compression/retrieve`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
