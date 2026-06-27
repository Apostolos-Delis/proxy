import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const BEDROCK_FIXTURES = [
  "caller-requests/openai-chat_to_bedrock-converse_text.request.json",
  "caller-requests/openai-chat_to_bedrock-converse_tool-history.request.json",
  "caller-requests/anthropic-messages_to_bedrock-converse_text.request.json",
  "caller-requests/anthropic-messages_to_bedrock-converse_tool-history.request.json",
  "caller-requests/openai-responses_to_bedrock-converse_text-stateless.request.json",
  "caller-requests/openai-responses_to_bedrock-converse_stateful-unsupported.request.json",
  "expected-converse/openai-chat_to_bedrock-converse_text.expected.json",
  "expected-converse/openai-chat_to_bedrock-converse_tool-history.expected.json",
  "expected-converse/anthropic-messages_to_bedrock-converse_text.expected.json",
  "expected-converse/anthropic-messages_to_bedrock-converse_tool-history.expected.json",
  "expected-converse/openai-responses_to_bedrock-converse_text-stateless.expected.json",
  "unsupported/openai-responses_to_bedrock-converse_stateful-unsupported.reason.json",
  "converse-responses/bedrock-converse_response_text.response.json",
  "converse-responses/bedrock-converse_response_tool-use.response.json",
  "converse-responses/bedrock-converse_response_usage-stop-reason.response.json",
  "converse-responses/bedrock-converse_response_guardrail-intervened.response.json",
  "converse-stream-events/bedrock-converse_stream_text.events.json",
  "converse-stream-events/bedrock-converse_stream_tool-call.events.json",
  "converse-stream-events/bedrock-converse_stream_metadata-usage.events.json",
  "converse-stream-events/bedrock-converse_stream_aws-exception.events.json",
  "expected-sse/openai-chat_bedrock-converse_stream_text.expected.sse",
  "expected-sse/openai-responses_bedrock-converse_stream_text.expected.sse",
  "expected-sse/anthropic-messages_bedrock-converse_stream_text.expected.sse",
  "expected-sse/openai-chat_bedrock-converse_stream_tool-call.expected.sse",
  "expected-sse/openai-responses_bedrock-converse_stream_tool-call.expected.sse",
  "expected-sse/anthropic-messages_bedrock-converse_stream_tool-call.expected.sse",
  "expected-sse/openai-chat_bedrock-converse_stream_metadata-usage.expected.sse",
  "expected-sse/openai-responses_bedrock-converse_stream_aws-exception.expected.sse"
] as const;

async function readFixture(name: string) {
  const path = fileURLToPath(new URL(`./fixtures/bedrock/${name}`, import.meta.url));
  const text = await readFile(path, "utf8");
  return name.endsWith(".sse") ? text : JSON.parse(text) as unknown;
}

describe("Bedrock translation fixtures", () => {
  it("loads every Bedrock fixture without network or AWS credentials", async () => {
    for (const name of BEDROCK_FIXTURES) {
      expect(name).toMatch(/(openai-chat|openai-responses|anthropic-messages|bedrock-converse)/);
      await expect(readFixture(name), name).resolves.toBeDefined();
    }
  });

  it("keeps stateful OpenAI Responses explicitly unsupported", async () => {
    const request = await readFixture(
      "caller-requests/openai-responses_to_bedrock-converse_stateful-unsupported.request.json"
    ) as { previous_response_id?: string };
    const reason = await readFixture(
      "unsupported/openai-responses_to_bedrock-converse_stateful-unsupported.reason.json"
    ) as { reason?: string };

    expect(request.previous_response_id).toBe("resp_previous_123");
    expect(reason.reason).toBe("previous_response_id_not_supported");
  });

  it("captures core ConverseStream event shapes", async () => {
    const text = await readFixture("converse-stream-events/bedrock-converse_stream_text.events.json") as unknown[];
    const tool = await readFixture("converse-stream-events/bedrock-converse_stream_tool-call.events.json") as unknown[];
    const metadata = await readFixture("converse-stream-events/bedrock-converse_stream_metadata-usage.events.json") as unknown[];
    const exception = await readFixture("converse-stream-events/bedrock-converse_stream_aws-exception.events.json") as unknown[];

    expect(text.some((event) => hasKey(event, "contentBlockDelta"))).toBe(true);
    expect(tool.some((event) => hasKey(event, "contentBlockStart"))).toBe(true);
    expect(metadata.some((event) => hasKey(event, "metadata"))).toBe(true);
    expect(exception.some((event) => hasKey(event, "throttlingException"))).toBe(true);
  });
});

function hasKey(value: unknown, key: string) {
  return value !== null && typeof value === "object" && key in value;
}
