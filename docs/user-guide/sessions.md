# Sessions And Request Replay

Sessions group related harness traffic so operators can inspect an agent conversation as a sequence instead of isolated requests.

## Where Sessions Come From

Proxy identifies sessions from harness metadata when available, including:

- Claude Code session and agent headers.
- OpenAI Responses session-ish identifiers.
- Request metadata and persisted request/session state.

When a session cannot be inferred, requests are still visible in **Logs** and **Prompts**.

## Use The Sessions Page

Open **Sessions** to inspect:

- Session start and most recent activity.
- Surface and harness.
- User and workspace attribution.
- Request count.
- Total tokens and cost.
- Route/model decisions across the conversation.

Use it when a user says "the agent made a bad choice" or "this session got expensive."

## Use The Logs Page

Open **Logs** for request-level evidence:

![Proxy logs page showing replayable agent sessions, models, routes, tokens, and cost](../assets/proxy-logs.png)

For each request, inspect:

- Prompt preview and artifact detail.
- Route decision and classifier result.
- Provider attempts.
- Usage and cost.
- Compression receipts.
- Events timeline.

## Prompt Artifacts

Prompt artifacts are the safe place for captured prompt text in this test project. Event payloads should not contain full prompt text.

Prompt capture modes are configured in **Settings**:

| Mode | Behavior |
| --- | --- |
| `raw_text` | Stores raw prompt text for inspection |
| `redacted` | Stores redacted text and metadata |
| `hash_only` | Stores hashes and metadata without content |
| `none` | Disables prompt artifact capture |

Use lower-capture modes when raw prompt inspection is not acceptable.

## Replay Workflow

1. Start from **Sessions** when the issue spans multiple turns.
2. Open the relevant request from the session timeline.
3. Check the route decision and selected provider/model.
4. Check provider attempts for failures, retries, or fallback.
5. Check usage and cost against the expected model tier.
6. Check compression receipts if tool output was large.
7. Use event timestamps to understand where latency accumulated.

## Common Findings

| Finding | Likely next step |
| --- | --- |
| Wrong tier selected | Inspect classifier output and routing config |
| Correct tier, wrong model | Inspect active routing config version |
| Provider attempt failed | Check provider health and upstream credential |
| Tokens unexpectedly high | Inspect prompt artifacts and compression receipts |
| Session cache busts | Check prompt stability, tool-result rewrites, and duplicated context |
