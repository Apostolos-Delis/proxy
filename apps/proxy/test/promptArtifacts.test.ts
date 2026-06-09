import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPgliteDatabase,
  events,
  organizationSettings,
  organizations,
  promptArtifacts,
  requests
} from "@prompt-proxy/db";

import { buildModelCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { createDatabasePersistence } from "../src/persistence/index.js";
import { buildServer } from "../src/server.js";
import { listen, startAnthropicMock, startOpenAIMock, type MockServer } from "./helpers.js";

function testEnv(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    EVENT_STORE_PATH: "",
    PROMPT_PROXY_TOKEN: "proxy-token",
    OPENAI_API_KEY: "openai-upstream-key",
    OPENAI_BASE_URL: "http://127.0.0.1",
    OPENAI_FAST_MODEL: "gpt-5.4-mini",
    OPENAI_BALANCED_MODEL: "gpt-5.4",
    OPENAI_HARD_MODEL: "gpt-5.5",
    OPENAI_DEEP_MODEL: "gpt-5.5-pro",
    ANTHROPIC_API_KEY: "anthropic-upstream-key",
    ANTHROPIC_BASE_URL: "http://127.0.0.1",
    ANTHROPIC_FAST_MODEL: "claude-haiku-4-5",
    ANTHROPIC_BALANCED_MODEL: "claude-sonnet-4-5",
    ANTHROPIC_HARD_MODEL: "claude-sonnet-4-5",
    ANTHROPIC_DEEP_MODEL: "claude-opus-4-5",
    CLASSIFIER_PROVIDER: "openai",
    CLASSIFIER_MODEL: "route-classifier-cheap",
    MODEL_COSTS_JSON: "",
    ROUTE_POLICY_SOURCE: "central",
    ...overrides
  };
}

describe("prompt artifact capture", () => {
  let app: ReturnType<typeof buildServer> | undefined;
  let client: PGlite | undefined;
  let openai: MockServer | undefined;
  let anthropic: MockServer | undefined;

  afterEach(async () => {
    await app?.close();
    await openai?.close();
    await anthropic?.close();
    await client?.close();
    app = undefined;
    openai = undefined;
    anthropic = undefined;
    client = undefined;
  });

  it("captures OpenAI string input, instructions, and tool metadata", async () => {
    const fixture = await captureFixture("org_openai_string");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        instructions: "Always answer in terse bullets.",
        input: "Write tests for @filename.",
        tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);
    const eventRows = await fixture.db.select().from(events);
    const captureEvent = eventRows.find((event) => event.eventType === "prompt_artifacts.captured");
    const requestDetail = captureEvent
      ? await fetch(`${fixture.proxyUrl}/admin/requests/${captureEvent.scopeId}`, {
          headers: { authorization: "Bearer proxy-token" }
        }).then((item) => item.json())
      : undefined;

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "instructions",
        storageMode: "raw_text",
        rawText: "Always answer in terse bullets.",
        sourceRole: "system"
      }),
      expect.objectContaining({
        kind: "latest_user_message",
        storageMode: "raw_text",
        rawText: "Write tests for @filename.",
        sourceRole: "user",
        sourceIndex: 0
      }),
      expect.objectContaining({
        kind: "tool_schema_metadata",
        storageMode: "hash_only",
        rawText: null,
        sourceRole: "tool",
        metadata: expect.objectContaining({
          surface: "openai-responses",
          toolCount: 1,
          tools: [{ type: "function", name: "shell" }]
        })
      })
    ]));
    expect(captureEvent?.payload).toEqual(expect.objectContaining({
      surface: "openai-responses",
      artifactCount: 3,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          artifactId: expect.any(String),
          kind: "instructions",
          storageMode: "raw_text",
          contentHash: expect.stringMatching(/^sha256:/)
        }),
        expect.objectContaining({
          artifactId: expect.any(String),
          kind: "latest_user_message",
          storageMode: "raw_text",
          contentHash: expect.stringMatching(/^sha256:/)
        }),
        expect.objectContaining({
          artifactId: expect.any(String),
          kind: "tool_schema_metadata",
          storageMode: "hash_only",
          metadata: expect.objectContaining({ toolCount: 1 })
        })
      ])
    }));
    expect(requestDetail?.events.map((event: any) => event.eventType)).toContain("prompt_artifacts.captured");
    expect(eventPayloadText(eventRows)).not.toContain("Always answer in terse bullets.");
    expect(eventPayloadText(eventRows)).not.toContain("Write tests for @filename.");
    expect(eventPayloadText(eventRows)).not.toContain("parameters");
  });

  it("captures only the latest OpenAI user message from array input", async () => {
    const fixture = await captureFixture("org_openai_array");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "old request" }] },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "ack" }] },
          { type: "message", role: "user", content: [{ type: "input_text", text: "latest request" }] }
        ],
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "latest_user_message",
        storageMode: "raw_text",
        rawText: "latest request",
        sourceRole: "user",
        sourceIndex: 2
      })
    ]));
    expect(rows.some((row) => row.rawText === "old request")).toBe(false);
  });

  it("captures Anthropic system, latest user message, and tool metadata", async () => {
    const fixture = await captureFixture("org_anthropic");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        system: "Use the mortgage domain rules.",
        messages: [
          { role: "user", content: "older question" },
          { role: "assistant", content: "ack" },
          { role: "user", content: [{ type: "text", text: "latest Claude question" }] }
        ],
        tools: [{ name: "bash", input_schema: { type: "object" } }],
        max_tokens: 1024,
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);
    const eventRows = await fixture.db.select().from(events);
    const captureEvent = eventRows.find((event) => event.eventType === "prompt_artifacts.captured");

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "system",
        storageMode: "raw_text",
        rawText: "Use the mortgage domain rules.",
        sourceRole: "system"
      }),
      expect.objectContaining({
        kind: "latest_user_message",
        storageMode: "raw_text",
        rawText: "latest Claude question",
        sourceRole: "user",
        sourceIndex: 2
      }),
      expect.objectContaining({
        kind: "tool_schema_metadata",
        storageMode: "hash_only",
        metadata: expect.objectContaining({
          surface: "anthropic-messages",
          toolCount: 1,
          tools: [{ type: null, name: "bash" }]
        })
      })
    ]));
    expect(captureEvent?.payload).toEqual(expect.objectContaining({
      surface: "anthropic-messages",
      artifactCount: 3,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "system" }),
        expect.objectContaining({ kind: "latest_user_message" }),
        expect.objectContaining({ kind: "tool_schema_metadata" })
      ])
    }));
    expect(eventPayloadText(eventRows)).not.toContain("Use the mortgage domain rules.");
    expect(eventPayloadText(eventRows)).not.toContain("latest Claude question");
    expect(eventPayloadText(eventRows)).not.toContain("input_schema");
  });

  it("fails before classifier or provider spend when prompt capture fails", async () => {
    const fixture = await captureFixture("org_capture_failure", "raw_text", true);

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "this should not reach the classifier",
        stream: true
      })
    });
    await response.text();

    expect(response.status).toBe(500);
    expect(openai?.records).toHaveLength(0);
  });

  it("keeps prompt content hash-only when raw capture is not enabled", async () => {
    const fixture = await captureFixture("org_hash_only", "hash_only");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Do not store me raw.",
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "latest_user_message",
        storageMode: "hash_only",
        rawText: null,
        sourceRole: "user"
      })
    ]));
    expect(rows.some((row) => row.rawText === "Do not store me raw.")).toBe(false);
  });

  it("handles empty input without writing raw prompt artifacts", async () => {
    const fixture = await captureFixture("org_empty");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: [],
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);

    expect(response.status).toBe(200);
    expect(rows.filter((row) => row.storageMode === "raw_text")).toHaveLength(0);
  });

  it("serves org-scoped prompt list and detail admin APIs", async () => {
    const fixture = await captureFixture("org_prompt_admin");

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "x-prompt-proxy-user-id": "user_prompt_admin"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Investigate prompt admin APIs.",
        stream: true
      })
    });
    await response.text();

    const prompts = await fetch(
      `${fixture.proxyUrl}/admin/prompts?userId=user_prompt_admin&surface=openai-responses&route=hard&model=gpt-5.5&limit=10&offset=0`,
      { headers: { authorization: "Bearer proxy-token" } }
    ).then((item) => item.json());
    const latestUser = prompts.data.find((item: any) => item.kind === "latest_user_message");
    const detail = await fetch(`${fixture.proxyUrl}/admin/prompts/${latestUser.artifactId}`, {
      headers: { authorization: "Bearer proxy-token" }
    }).then((item) => item.json());

    await fixture.db.insert(organizations).values({
      id: "org_other",
      slug: "org-other",
      name: "Other Org"
    });
    await fixture.db.insert(requests).values({
      id: "request_other",
      organizationId: "org_other",
      surface: "openai-responses",
      idempotencyKey: "idem_other",
      requestedModel: "router-auto",
      inputHash: "sha256:other",
      inputChars: 5
    });
    await fixture.db.insert(promptArtifacts).values({
      id: "artifact_other",
      organizationId: "org_other",
      requestId: "request_other",
      kind: "latest_user_message",
      storageMode: "raw_text",
      contentHash: "sha256:other",
      rawText: "other org prompt"
    });
    const crossOrg = await fetch(`${fixture.proxyUrl}/admin/prompts/artifact_other`, {
      headers: { authorization: "Bearer proxy-token" }
    });

    expect(response.status).toBe(200);
    expect(prompts.pagination).toEqual({ limit: 10, offset: 0, count: expect.any(Number) });
    expect(prompts.data.length).toBeGreaterThan(0);
    expect(prompts.data.every((item: any) => item.userId === "user_prompt_admin")).toBe(true);
    expect(latestUser).toEqual(expect.objectContaining({
      surface: "openai-responses",
      storageMode: "raw_text",
      preview: "Investigate prompt admin APIs.",
      finalRoute: "hard",
      provider: "openai",
      selectedModel: "gpt-5.5"
    }));
    expect(detail.artifact.rawText).toBe("Investigate prompt admin APIs.");
    expect(detail.request).toEqual(expect.objectContaining({
      requestId: latestUser.requestId,
      provider: "openai",
      selectedModel: "gpt-5.5",
      finalRoute: "hard"
    }));
    expect(detail.events.map((event: any) => event.eventType)).toContain("prompt_artifacts.captured");
    expect(crossOrg.status).toBe(404);
  });

  async function captureFixture(
    organizationId: string,
    promptCaptureMode: "hash_only" | "raw_text" = "raw_text",
    failCapture = false
  ) {
    client = new PGlite();
    const migration = await readFile(
      fileURLToPath(new URL("../../../packages/db/migrations/0000_foundation.sql", import.meta.url)),
      "utf8"
    );
    await client.exec(migration);
    const db = createPgliteDatabase(client);
    openai = await startOpenAIMock();
    anthropic = await startAnthropicMock();
    const config = loadConfig({
      ...testEnv(),
      DEFAULT_ORGANIZATION_ID: organizationId,
      OPENAI_BASE_URL: openai.url,
      ANTHROPIC_BASE_URL: anthropic.url,
      LOG_LEVEL: "fatal"
    });
    const catalog = buildModelCatalog(config);
    const persistence = createDatabasePersistence(db, catalog, config, false);
    if (failCapture) {
      persistence.promptArtifacts.capture = async () => {
        throw new Error("capture_failed");
      };
    }

    await db.insert(organizations).values({
      id: organizationId,
      slug: organizationId,
      name: organizationId
    });
    await db.insert(organizationSettings).values({
      organizationId,
      promptCaptureMode
    });

    app = buildServer(config, { persistence });
    const proxyUrl = await listen(app);
    return { db, proxyUrl };
  }
});

function eventPayloadText(rows: Array<typeof events.$inferSelect>) {
  return rows.map((row) => JSON.stringify(row.payload)).join("\n");
}
