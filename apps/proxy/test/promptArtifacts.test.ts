import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  events,
  promptArtifacts
} from "@prompt-proxy/db";

import { adminGql, captureFixture, eventPayloadText, type PromptTestFixture } from "./promptTestFixture.js";

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
      ? (await adminGql(
          fixture.proxyUrl,
          fixture.adminHeaders,
          "query RequestDetail($requestId: ID!) { request(requestId: $requestId) { events { eventType } } }",
          { requestId: captureEvent.scopeId }
        )).data?.request
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
        kind: "user_message",
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
          kind: "user_message",
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

  it("captures every OpenAI input message with its conversation position", async () => {
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
          { type: "function_call", name: "shell", arguments: "{\"command\":\"ls\"}" },
          { type: "function_call_output", output: "file.ts" },
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
        kind: "user_message",
        rawText: "old request",
        sourceRole: "user",
        sourceIndex: 0
      }),
      expect.objectContaining({
        kind: "assistant_response",
        rawText: "ack",
        sourceRole: "assistant",
        sourceIndex: 1
      }),
      expect.objectContaining({
        kind: "tool_use",
        rawText: "shell {\"command\":\"ls\"}",
        sourceRole: "assistant",
        sourceIndex: 2
      }),
      expect.objectContaining({
        kind: "tool_result",
        rawText: "file.ts",
        sourceRole: "tool",
        sourceIndex: 3
      }),
      expect.objectContaining({
        kind: "user_message",
        rawText: "latest request",
        sourceRole: "user",
        sourceIndex: 4
      })
    ]));
  });

  it("captures Anthropic system, conversation messages, and tool metadata", async () => {
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
        kind: "user_message",
        storageMode: "raw_text",
        rawText: "older question",
        sourceRole: "user",
        sourceIndex: 0
      }),
      expect.objectContaining({
        kind: "assistant_response",
        storageMode: "raw_text",
        rawText: "ack",
        sourceRole: "assistant",
        sourceIndex: 1
      }),
      expect.objectContaining({
        kind: "user_message",
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
      artifactCount: 5,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "system" }),
        expect.objectContaining({ kind: "user_message" }),
        expect.objectContaining({ kind: "assistant_response" }),
        expect.objectContaining({ kind: "tool_schema_metadata" })
      ])
    }));
    expect(eventPayloadText(eventRows)).not.toContain("Use the mortgage domain rules.");
    expect(eventPayloadText(eventRows)).not.toContain("latest Claude question");
    expect(eventPayloadText(eventRows)).not.toContain("input_schema");
  });

  it("separates typed prompts, injected context, and tool traffic in agentic turns", async () => {
    const fixture = await setup("org_anthropic_agentic");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "<system-reminder>injected harness rules</system-reminder>" },
              { type: "text", text: "fix the login bug" }
            ]
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Looking at the auth flow." },
              { type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls" } }
            ]
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "auth.ts" }] }
            ]
          }
        ],
        max_tokens: 1024,
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "user_message",
        rawText: "fix the login bug",
        sourceRole: "user",
        sourceIndex: 0
      }),
      expect.objectContaining({
        kind: "injected_context",
        rawText: "<system-reminder>injected harness rules</system-reminder>",
        sourceRole: "user",
        sourceIndex: 0
      }),
      expect.objectContaining({
        kind: "assistant_response",
        rawText: "Looking at the auth flow.",
        sourceRole: "assistant",
        sourceIndex: 1
      }),
      expect.objectContaining({
        kind: "tool_use",
        rawText: "bash {\"command\":\"ls\"}",
        sourceRole: "assistant",
        sourceIndex: 1
      }),
      expect.objectContaining({
        kind: "tool_result",
        rawText: "auth.ts",
        sourceRole: "tool",
        sourceIndex: 2
      })
    ]));
  });

  it("captures each session message once across requests", async () => {
    const fixture = await setup("org_anthropic_dedup");
    const headers = {
      authorization: "Bearer proxy-token",
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": "session-dedup"
    };
    const system = "Shared session rules.";
    const firstTurn = [{ role: "user", content: "first question" }];

    const first = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "claude-router-auto", system, messages: firstTurn, max_tokens: 256, stream: true })
    });
    await first.text();
    const second = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-router-auto",
        system,
        messages: [
          ...firstTurn,
          { role: "assistant", content: "first answer" },
          { role: "user", content: "second question" }
        ],
        max_tokens: 256,
        stream: true
      })
    });
    await second.text();

    const rows = await fixture.db.select().from(promptArtifacts);
    const byKind = (kind: string) => rows.filter((row) => row.kind === kind);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(byKind("system")).toHaveLength(1);
    expect(byKind("user_message").map((row) => row.rawText).sort()).toEqual([
      "first question",
      "second question"
    ]);
    const firstQuestion = byKind("user_message").find((row) => row.rawText === "first question");
    const secondQuestion = byKind("user_message").find((row) => row.rawText === "second question");
    expect(firstQuestion?.requestId).not.toBe(secondQuestion?.requestId);
  });

  it("links Anthropic sessions from metadata.user_id when no session header is set", async () => {
    const fixture = await setup("org_anthropic_metadata_session");

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        metadata: { user_id: "user_abc123_account_def456_session_9f8e7d6c-1a2b-3c4d-5e6f-7a8b9c0d1e2f" },
        messages: [{ role: "user", content: "metadata session linking" }],
        max_tokens: 256,
        stream: true
      })
    });
    await response.text();

    const sessions = await fixture.db.select().from(agentSessions);

    expect(response.status).toBe(200);
    expect(sessions).toEqual([
      expect.objectContaining({
        externalSessionId: "9f8e7d6c-1a2b-3c4d-5e6f-7a8b9c0d1e2f",
        metadata: expect.objectContaining({ sessionIdentity: "harness" })
      })
    ]);
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
        kind: "user_message",
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


  it("captures the streamed OpenAI assistant response as an artifact", async () => {
    const fixture = await setup("org_openai_response", "raw_text", false, {
      openAIOptions: { outputText: "Streamed mock answer." }
    });

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "Summarize the build failure.",
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);
    const eventRows = await fixture.db.select().from(events);

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "assistant_response",
        storageMode: "raw_text",
        rawText: "Streamed mock answer.",
        sourceRole: "assistant"
      })
    ]));
    expect(eventPayloadText(eventRows)).not.toContain("Streamed mock answer.");
    expect(eventRows.map((row) => JSON.stringify(row.metadata)).join("\n")).not.toContain("Streamed mock answer.");
  });

  it("captures the streamed Anthropic assistant response as an artifact", async () => {
    const fixture = await setup("org_anthropic_response", "raw_text", false, {
      anthropicOptions: { outputText: "Claude mock answer." }
    });

    const response = await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-router-auto",
        messages: [{ role: "user", content: "What changed?" }],
        max_tokens: 256,
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);
    const eventRows = await fixture.db.select().from(events);

    expect(response.status).toBe(200);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "assistant_response",
        storageMode: "raw_text",
        rawText: "Claude mock answer.",
        sourceRole: "assistant"
      })
    ]));
    expect(eventPayloadText(eventRows)).not.toContain("Claude mock answer.");
  });

  it("keeps assistant responses hash-only when raw capture is not enabled", async () => {
    const fixture = await setup("org_response_hash_only", "hash_only", false, {
      openAIOptions: { outputText: "Do not store this answer raw." }
    });

    const response = await fetch(`${fixture.proxyUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "router-auto",
        input: "hash only please",
        stream: true
      })
    });
    await response.text();

    const rows = await fixture.db.select().from(promptArtifacts);

    expect(response.status).toBe(200);
    const assistantRow = rows.find((row) => row.kind === "assistant_response");
    expect(assistantRow).toMatchObject({ storageMode: "hash_only", rawText: null });
    expect(rows.some((row) => row.rawText === "Do not store this answer raw.")).toBe(false);
  });

  async function setup(
    organizationId: string,
    promptCaptureMode: "hash_only" | "raw_text" = "raw_text",
    failCapture = false,
    options: Parameters<typeof captureFixture>[3] = {}
  ) {
    activeFixture = await captureFixture(organizationId, promptCaptureMode, failCapture, options);
    return activeFixture;
  }
});
