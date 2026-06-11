import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { EventService } from "../src/events.js";
import {
  compressForForward,
  compressToolResults,
  MIN_COMPRESSIBLE_CHARS,
  compressionRules,
  type CompressionRule
} from "../src/toolResultCompression.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

// A trivial deterministic rule for scaffold testing: truncate to a marker.
const truncateRule: CompressionRule = {
  label: "test-truncate",
  matches: (name) => name === "Bash",
  filter: ({ content }) => (typeof content === "string" ? `${content.slice(0, 10)}…[truncated]` : undefined)
};

const big = "x".repeat(MIN_COMPRESSIBLE_CHARS + 100);

describe("compressToolResults", () => {
  it("leaves non-matching tools untouched under the default registry", () => {
    // The default registry only carries the mcp__* rule, so a Bash result is
    // not compressed and its content is preserved verbatim.
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body) as any;
    expect(result.records).toEqual([]);
    expect(result.body.messages[1].content[0].content).toBe(big);
  });

  it("compresses a verbose mcp__* result under the default registry", () => {
    const verbose = JSON.stringify({ items: Array.from({ length: 80 }, (_, i) => ({ id: i, note: null })) }, null, 2);
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body) as any;
    expect(result.records).toHaveLength(1);
    expect(result.records[0].tool).toBe("mcp__linear__list");
    expect(result.body.messages[1].content[0].content.length).toBeLessThan(verbose.length);
  });

  it("maps tool_use_id to tool name and applies a matching rule (Anthropic)", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "pytest" } },
            { type: "tool_use", id: "t2", name: "Read", input: { path: "a.ts" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: big },
            { type: "tool_result", tool_use_id: "t2", content: big }
          ]
        }
      ]
    };

    const result = compressToolResults("anthropic-messages", body, [truncateRule]) as any;

    // Only the Bash result is compressed; Read does not match the rule.
    expect(result.records).toEqual([
      { tool: "Bash", rule: "test-truncate", beforeChars: big.length, afterChars: "xxxxxxxxxx…[truncated]".length }
    ]);
    expect(result.body.messages[1].content[0].content).toBe("xxxxxxxxxx…[truncated]");
    expect(result.body.messages[1].content[1].content).toBe(big);
    // Original body is not mutated (rewritten spines are rebuilt, not aliased).
    expect((body.messages[1].content[0] as any).content).toBe(big);
  });

  it("handles tool_result content as an array of blocks", () => {
    const bigArray = [{ type: "text", text: "y".repeat(MIN_COMPRESSIBLE_CHARS + 50) }];
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bigArray }] }
      ]
    };
    const arrayRule: CompressionRule = {
      label: "array-rule",
      matches: (name) => name === "Bash",
      filter: () => "compacted"
    };
    const result = compressToolResults("anthropic-messages", body, [arrayRule]) as any;
    expect(result.records).toHaveLength(1);
    expect(result.body.messages[1].content[0].content).toBe("compacted");
  });

  it("falls back to the unknown tool name when the assistant tool_use turn is missing", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: big }] }
      ]
    };
    const seen: string[] = [];
    const recordingRule: CompressionRule = {
      label: "record",
      matches: (name) => { seen.push(name); return false; },
      filter: () => undefined
    };
    compressToolResults("anthropic-messages", body, [recordingRule]);
    expect(seen).toEqual(["unknown"]);
  });

  it("uses last-write-wins for a reused tool_use_id", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "dup", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "dup", content: "first" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "dup", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "dup", content: big }] }
      ]
    };
    const seen: string[] = [];
    const recordingRule: CompressionRule = {
      label: "record",
      matches: (name) => { seen.push(name); return false; },
      filter: () => undefined
    };
    compressToolResults("anthropic-messages", body, [recordingRule]);
    // Only the second result clears the size threshold; the id maps to the
    // latest tool_use registration (Read).
    expect(seen).toEqual(["Read"]);
  });

  it("skips results below the size threshold", () => {
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "small" }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body, [truncateRule]);
    expect(result.records).toEqual([]);
  });

  it("maps call_id to function name and applies a rule (OpenAI)", () => {
    const body = {
      input: [
        { type: "function_call", call_id: "c1", name: "Bash", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: big }
      ]
    };
    const result = compressToolResults("openai-responses", body, [truncateRule]) as any;
    expect(result.records[0].tool).toBe("Bash");
    expect(result.body.input[1].output).toBe("xxxxxxxxxx…[truncated]");
  });

  it("never grows a block: a rule that expands content is discarded", () => {
    const expandRule: CompressionRule = {
      label: "expand",
      matches: () => true,
      filter: ({ content }) => `${String(content)}-and-then-some-more-and-more`
    };
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }
      ]
    };
    const result = compressToolResults("anthropic-messages", body, [expandRule]) as any;
    expect(result.records).toEqual([]);
    expect(result.body.messages[1].content[0].content).toBe(big);
  });

  it("is deterministic: identical input yields identical output bytes", () => {
    const make = () => ({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }
      ]
    });
    const a = compressToolResults("anthropic-messages", make(), [truncateRule]);
    const b = compressToolResults("anthropic-messages", make(), [truncateRule]);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
  });
});

describe("compressForForward", () => {
  // Uses a tool name no real registered rule matches, so the pushed stub rule
  // is the only matcher regardless of registration order.
  function body() {
    return {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "StubTool", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }
      ]
    };
  }

  const forwardInput = (events: EventService, overrides: Record<string, unknown> = {}) => ({
    events,
    tenantId: "org_1",
    workspaceId: "org_1:workspace:default",
    requestId: "request_1",
    idempotencyKey: "idem_1",
    sessionId: "session_1",
    surface: "anthropic-messages" as const,
    body: body(),
    enabled: true,
    warn: () => {},
    ...overrides
  });

  it("emits no event and returns the body unchanged when the org has not opted in", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_1");
    const original = body();
    const result = await compressForForward(forwardInput(events, { body: original, enabled: false }));
    expect(result).toBe(original);
    expect(events.listEvents()).toHaveLength(0);
  });

  it("returns the compressed body even when the event append fails", async () => {
    const failingSink = { append: async () => { throw new Error("sink down"); } };
    const events = new EventService(undefined, undefined, failingSink, "org_1");
    compressionRules.push(truncateForward);
    try {
      const result = await compressForForward(forwardInput(events)) as any;
      // Compression applied despite the event sink throwing.
      expect(result.messages[1].content[0].content).toContain("[truncated]");
    } finally {
      compressionRules.pop();
    }
  });

  it("emits a compression.recorded event carrying only sizes, never tool content", async () => {
    const events = new EventService(undefined, undefined, undefined, "org_1");
    compressionRules.push(truncateForward);
    try {
      await compressForForward(forwardInput(events));
      const recorded = events.listEvents().find((event) => event.eventType === "compression.recorded");
      expect(recorded).toBeTruthy();
      expect(recorded?.redactionState).toBe("not_applicable");
      const payload = recorded?.payload as Record<string, unknown>;
      expect(payload.blocks).toBe(1);
      expect(payload.savedChars).toBeGreaterThan(0);
      // The serialized payload must not leak the raw tool output.
      expect(JSON.stringify(payload)).not.toContain(big.slice(0, 50));
      const byRule = payload.byRule as Record<string, unknown>[];
      expect(Object.keys(byRule[0]).sort()).toEqual(["afterChars", "beforeChars", "rule", "tool"]);
    } finally {
      compressionRules.pop();
    }
  });
});

const truncateForward: CompressionRule = {
  label: "forward-truncate",
  matches: (name) => name === "StubTool",
  filter: ({ content }) => (typeof content === "string" ? `${content.slice(0, 10)}…[truncated]` : undefined)
};

describe("toolResultCompression end to end (DB-backed)", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  });

  // Pretty-printed MCP-style JSON well above MIN_COMPRESSIBLE_CHARS.
  const verbose = JSON.stringify(
    { items: Array.from({ length: 120 }, (_, i) => ({ id: i, note: null })) },
    null,
    2
  );

  it("rewrites oversized mcp__ tool results in the forwarded Anthropic body when the org flag is on", async () => {
    fixture = await captureFixture("org_compress_http");
    await fixture.persistence.organizationSettings.setToolResultCompression("org_compress_http", true);

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        messages: [
          { role: "user", content: "list the open issues" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    const forwarded = providerCall?.body.messages[2].content[0].content;
    expect(typeof forwarded).toBe("string");
    expect(forwarded.length).toBeLessThan(verbose.length);
    // Lossless: only formatting whitespace is gone.
    expect(JSON.parse(forwarded)).toEqual(JSON.parse(verbose));
  });

  it("leaves the forwarded body untouched when the org has not opted in", async () => {
    fixture = await captureFixture("org_compress_off");

    await fetch(`${fixture.proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer proxy-token", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-router-hard",
        max_tokens: 256,
        messages: [
          { role: "user", content: "list the open issues" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: verbose }] }
        ]
      })
    });

    const providerCall = fixture.anthropic.records.find((rec) => rec.path === "/messages");
    expect(providerCall?.body.messages[2].content[0].content).toBe(verbose);
  });

  it("rewrites oversized function_call_output items on the WebSocket surface", async () => {
    fixture = await captureFixture("org_compress_ws");
    await fixture.persistence.organizationSettings.setToolResultCompression("org_compress_ws", true);

    const ws = new WebSocket(fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses", {
      headers: {
        authorization: "Bearer proxy-token",
        "openai-beta": "responses_websockets=2026-02-06",
        session_id: "compress-ws-session"
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({
      type: "response.create",
      model: "router-hard",
      input: [
        { type: "function_call", call_id: "c1", name: "mcp__linear__list_issues", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: verbose }
      ],
      tools: [{ type: "function", name: "mcp__linear__list_issues" }],
      stream: true
    }));
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => {
        const event = JSON.parse(String(data));
        if (event.type === "response.completed" || event.type === "response.incomplete") resolve();
      });
      ws.once("error", reject);
    });
    ws.close();

    const providerCall = fixture.openai.records.find(
      (rec) => rec.body.type === "response.create" && Array.isArray(rec.body.input)
    );
    const forwarded = providerCall?.body.input[1].output;
    expect(typeof forwarded).toBe("string");
    expect(forwarded.length).toBeLessThan(verbose.length);
    expect(JSON.parse(forwarded)).toEqual(JSON.parse(verbose));
  });
});
