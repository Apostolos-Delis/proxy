# Tool Result Compression Walkthrough

## Summary

The `toolResultCompression` organization setting compresses large tool-result blocks before the proxy forwards a request to OpenAI or Anthropic. The current implementation focuses on deterministic, lossless rewrites:

- MCP JSON results: strip insignificant whitespace outside JSON string literals.
- Shell output: strip terminal noise such as ANSI escapes and carriage-return progress rewrites.

The main product value is compounding savings. Coding harnesses replay the full conversation history on every subsequent model request, so one large tool result is paid for again and again for the rest of the session. Shrinking it before forwarding reduces the first cache write and every later cache read, as long as the transform is deterministic.

## Real-World MCP Example

An MCP server such as Linear may return pretty-printed JSON:

```json
{
  "issues": [
    {
      "id": 1180591620717411303424,
      "title": "Fix login \"redirect\" bug",
      "estimate": 1.0,
      "assignee": null,
      "labels": ["bug", "auth"]
    }
  ]
}
```

With compression enabled, the provider receives the same JSON values in compact form:

```json
{"issues":[{"id":1180591620717411303424,"title":"Fix login \"redirect\" bug","estimate":1.0,"assignee":null,"labels":["bug","auth"]}]}
```

The implementation deliberately does not use `JSON.stringify(JSON.parse(text))`. A parse/stringify round trip can corrupt or normalize data that the model may need exactly:

- Integers beyond `2^53`, common in GitHub, Linear, and Slack IDs, can lose precision.
- Numeric spelling such as `1.0` can become `1`.
- Object key order, duplicate keys, and explicit `null` values can be changed by reserialization.

Instead, `apps/proxy/src/compressionRules/mcpJson.ts` validates that the text is JSON and then runs a character-level scanner that copies string literals verbatim while removing only spaces, tabs, and newlines outside strings.

## Request Shapes

The proxy handles both provider surfaces with equivalent matching logic.

Anthropic Messages API places tool calls and results inside message content blocks. The result block only has a `tool_use_id`, so the proxy first maps assistant `tool_use` IDs to tool names:

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_01ABC",
      "name": "mcp__linear__list_issues",
      "input": {
        "teamId": "ENG",
        "first": 30
      }
    }
  ]
}
```

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01ABC",
      "content": [
        {
          "type": "text",
          "text": "{\n  \"issues\": []\n}"
        }
      ]
    }
  ]
}
```

OpenAI Responses API uses flat input items paired by `call_id`:

```json
{
  "type": "function_call",
  "call_id": "call_abc",
  "name": "mcp__linear__list_issues",
  "arguments": "{\"teamId\":\"ENG\",\"first\":30}"
}
```

```json
{
  "type": "function_call_output",
  "call_id": "call_abc",
  "output": "{\n  \"issues\": []\n}"
}
```

`apps/proxy/src/toolResultCompression.ts` walks each shape, builds the ID-to-tool-name map, applies the first matching compression rule, and rebuilds only the message or item spine that changed. Unchanged objects keep their original references, and rewritten blocks preserve other fields such as `cache_control`.

## Pipeline

1. The operations console setting is defined in `apps/web/src/settingsPageData.ts` as `toolResultCompression`.
2. Routing config resolution exposes the setting as `resolved.toolResultCompression`.
3. Forwarding paths call `compressForForward` before sending bytes upstream.
4. `compressToolResults` chooses the Anthropic or OpenAI walker.
5. The walker maps tool result IDs to tool names and passes the content to the first matching `CompressionRule`.
6. A rule can return replacement content or `undefined` to leave the block untouched.
7. The shared guard records the rewrite only if the replacement is smaller than the original.
8. Successful rewrites emit a `compression.recorded` event with before/after character counts.

Event write failures never affect the forwarded bytes. That matters because compression has to be a pure function of the block content and static org setting, not a function of per-request event I/O.

## Current Rules

### MCP JSON Whitespace

`mcpJsonRule` matches tool names starting with `mcp__`. It accepts either a bare string or Anthropic-style text blocks. It only rewrites well-formed JSON whose trimmed text starts with `{` or `[`.

The rule is lossless for JSON values because it:

- Copies every character inside string literals.
- Preserves numeric text, including large integers and `1.0`.
- Preserves explicit `null` values.
- Preserves object key order and duplicate keys.
- Removes only whitespace outside strings.

### Shell Output Noise

`bashOutputRule` matches common harness shell tools: `Bash`, `shell`, `local_shell`, and `run_terminal_cmd`.

It removes formatting that a terminal would not display as durable output:

- ANSI control sequences.
- Carriage-return progress rewrites, keeping the final visible line state.

It does not drop real output lines, summarize logs, or apply command-specific semantic filters. Those higher-gain RTK-style filters are client-side features unless the proxy can prove a lossless representation.

## Cache-Stability Constraint

The central invariant is deterministic output. A tool result enters the harness transcript once, then gets replayed on every later request. If the proxy rewrites the same block differently on different turns, the provider prompt-cache prefix changes and the session pays a cache bust.

Safe proxy-side transforms have these properties:

- Pure function of the tool-result content and static rule version.
- No LLM calls or randomization.
- No request-time timestamps, counters, or event-write-dependent behavior.
- Same transform in token-count requests and forward requests.
- Explicit versioning when a rule changes output bytes.

This is why whitespace stripping is a strong fit: it is invisible to JSON semantics and stable across replay.

## Measured Token Savings From The Transcript

The transcript measured two realistic payloads using the OpenAI `o200k` tokenizer:

| Payload | Pretty JSON | Stripped JSON | TOON |
| --- | ---: | ---: | ---: |
| Uniform array, 30 Linear-style issues, about 10 KB | 3,350 tokens | 2,431 tokens, -27.4% | 1,834 tokens, -45.3% |
| Nested GitHub-PR-style payload, about 1 KB | 345 tokens | 233 tokens, -32.5% | 249 tokens, -27.8% |

The whitespace rule saved roughly 27-33% of input tokens on those pretty-printed JSON fixtures. The compounding effect is larger than the one-turn savings: if a 10 KB result appears at turn 3 of a 30-turn session, about 919 saved tokens can repeat across roughly 27 later requests, or about 25K input tokens avoided from one tool call.

These numbers are tokenizer-specific, but the percentage savings are the useful planning signal.

## TOON, RTK Tables, And Learned Compression

### TOON

TOON is not impossible, but it has sharp edges for this proxy:

- It requires parsing JSON and re-encoding, which can reintroduce large-number and numeric-normalization risk unless the encoder preserves raw numbers.
- It can outperform compact JSON on uniform arrays but regress on nested or non-uniform data.
- It changes the representation the model reads, unlike whitespace stripping.
- A character-count guard is not enough because TOON can shrink characters while increasing tokens.

If implemented, TOON-like output should be a separate rule that only fires for clearly tabular payloads, proves number safety, and falls back to JSON whitespace stripping otherwise.

### RTK-Style Table Rendering

The most promising next lossless structured-data direction is RTK-style table rendering for uniform object arrays. It targets the same shape as TOON but can be designed as a deterministic `CompressionRule`.

Before using it proxy-side, verify:

- Number safety for IDs beyond `2^53` and numeric spellings such as `1.0`.
- No row caps, cell caps, or omission markers in the default rule.
- Stable, pinned rule version so byte output changes are deliberate.
- Token-count guard or a narrow eligibility heuristic, not character count alone.

This can be slotted ahead of `mcpJsonRule`: tabularize when safe and token-beneficial, otherwise fall through to whitespace stripping.

### Learned Token Pruning

The Token Company and LLMLingua-style compressors prune low-signal tokens with a learned model. That can work for prose, but it is risky for coding-agent traffic because code, logs, diffs, IDs, flags, and line numbers are often exactly the details the model must preserve.

A reasonable experiment scope would be:

- Large prose-only web fetch or search results.
- Separate org flag.
- Content-hash memoization so replayed history does not pay repeated compressor latency.
- Quality monitoring for retries or follow-up tool calls caused by missing detail.

It should not touch structured data, code, diffs, or logs by default.

## Easy Lossless Wins To Scope Next

The immediate lossless program is narrower than "compress everything":

1. Extend the existing attribution pipeline.
   `tokens.attributed` already captures request buckets and tool-result offenders. Extend it with the missing compression-specific measurements, token-aware savings, and any buckets needed to rank the next rule.

2. Keep the current whitespace and terminal-noise rules conservative.
   The shipped rules are cheap, deterministic, and broadly safe. They should remain the fallback baseline.

3. Add token-aware measurement to compression events.
   `compression.recorded` currently tracks character counts. TOON-style or table-style rules need token counts or at least offline token benchmarks because character shrinkage can be a token regression.

4. Spike RTK-style MCP table rendering for uniform arrays.
   Build fixtures with Linear, GitHub, Slack, and analytics-style payloads. Prove number preservation and token savings before adding a rule.

5. Pin compression rule versions.
   Include the rule label and version in events. Treat output-byte changes as deliberate releases because they can cause one-time cache churn.

6. Ensure token-count and forward paths apply identical transforms.
   Harnesses rely on token-count endpoints for compaction decisions. Any mismatch makes the harness believe it has more or less room than the provider will actually see.

7. Keep lossy filters client-side unless there is an explicit proxy product contract.
   RTK's 60-90% savings come from semantic, command-aware filters with a local escape hatch. A transparent proxy should not silently drop potentially needed data.

The broader roadmap lives in [Token Cost Reduction](token-cost-reduction.md). This walkthrough is the implementation and decision context for the `toolResultCompression` setting and the next lossless compression candidates.
