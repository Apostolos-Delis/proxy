# Retrieval Tool Injection Spike

## Decision

Defer automatic `proxy_retrieve_compressed` tool injection for V1.

The V1 recovery path remains:

- model-visible retrieval markers in compressed blocks
- `POST /v1/compression/retrieve` with API-key authentication
- console retrieval links and receipt metadata

Automatic provider tool injection should ship only after the proxy has a deliberate tool-call execution loop. Injecting a tool schema alone does not make retrieval work: both Anthropic Messages and OpenAI Responses return tool calls to the client, and this proxy currently forwards provider responses instead of executing model-requested tools on the client's behalf.

## Prototype Shape

Anthropic Messages candidate:

```json
{
  "name": "proxy_retrieve_compressed",
  "description": "Retrieve original tool-result text for a prompt compression marker.",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "retrievalId": { "type": "string", "pattern": "^cmp_[a-f0-9]{32}$" },
      "query": { "type": "string" }
    },
    "required": ["retrievalId"]
  }
}
```

OpenAI Responses candidate:

```json
{
  "type": "function",
  "name": "proxy_retrieve_compressed",
  "description": "Retrieve original tool-result text for a prompt compression marker.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "retrievalId": { "type": "string", "pattern": "^cmp_[a-f0-9]{32}$" },
      "query": { "type": "string" }
    },
    "required": ["retrievalId"]
  }
}
```

## Stability Findings

Tool-list injection is not cache-neutral. Adding an internal tool changes provider-visible request bytes and can invalidate prompt-cache prefixes unless the tool is injected from the first turn and remains stable for the whole session.

Harness tool ownership is unclear. Claude Code, Codex, Cursor, and opencode already send harness-specific tool declarations. Injecting an internal tool risks name collision, `tool_choice` conflicts, and strict tool-list mismatches in native harness fixtures.

Translation paths are not a safe place to hide this behavior. A retrieval tool would need exact preservation through Anthropic Messages and OpenAI Responses native paths before any translated path can be trusted.

Tool execution requires a new proxy responsibility. If the model calls `proxy_retrieve_compressed`, the proxy would need to pause the provider response loop, resolve the retrieval id under the original tenant/workspace/API-key context, append a provider-specific tool result, and continue the model turn. That is separate from the existing retrieval endpoint.

## UX Failure Modes

- The model emits a tool call that the client does not know how to execute.
- The tool call appears in a harness transcript as an unexpected user-visible action.
- Retrieval fails because the marker expired, artifact capture was disabled, or raw text is unavailable.
- A user sees the internal tool and tries to call it directly with an id from another workspace.
- Tool injection changes the request enough to erase cache savings the compression feature was meant to protect.

## Follow-Up If Reopened

1. Add a per-surface capability flag for internal retrieval tool injection.
2. Add provider-specific tests proving stable tool lists from session start through pinned continuations.
3. Add a server-side tool-call executor that resolves retrieval ids without exposing raw ids or cross-tenant existence.
4. Add streaming observers for retrieval tool calls and tool results.
5. Add failure UX for expired, unavailable, and unauthorized retrieval markers.

Until those pieces exist, endpoint and console retrieval are the V1 recovery path.
