import { afterEach, describe, expect, it } from "vitest";

import {
  events,
  promptArtifacts
} from "@prompt-proxy/db";

import { captureFixture, eventPayloadText, type PromptTestFixture } from "./promptTestFixture.js";

describe("prompt artifact capture", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("captures OpenAI string input, instructions, and tool metadata", async () => {
    const fixture = await setup("org_openai_string");

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
          headers: fixture.adminHeaders
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
    const fixture = await setup("org_openai_array");

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
    const fixture = await setup("org_anthropic");

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
    const fixture = await setup("org_capture_failure", "raw_text", true);

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
    expect(fixture.openai.records).toHaveLength(0);
  });

  it("keeps prompt content hash-only when raw capture is not enabled", async () => {
    const fixture = await setup("org_hash_only", "hash_only");

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
    const fixture = await setup("org_empty");

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


  async function setup(
    organizationId: string,
    promptCaptureMode: "hash_only" | "raw_text" = "raw_text",
    failCapture = false
  ) {
    activeFixture = await captureFixture(organizationId, promptCaptureMode, failCapture);
    return activeFixture;
  }
});
