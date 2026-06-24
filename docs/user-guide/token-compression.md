# Token Compression

Token compression reduces repeated tool-result cost before requests are sent upstream. It is designed for coding-agent transcripts where one large tool result can be replayed on every later turn.

## What It Compresses

Current rules focus on deterministic, lossless rewrites:

- JSON tool results: remove whitespace outside string literals without parsing and reserializing.
- Shell output: remove terminal noise such as ANSI escapes and carriage-return progress rewrites.
- Duplicate tool results: optionally replace later exact duplicates with deterministic references.

Prompt text, code, diffs, and logs are not summarized by an LLM.

## Why Determinism Matters

Provider prompt caches depend on byte-stable prefixes. If the same tool result is rewritten differently on later turns, the cache prefix changes and the session can pay again.

Safe compression rules are:

- Pure functions of content and rule version.
- No randomization or timestamps.
- No LLM calls.
- Stable across token-count and forwarding paths.
- Versioned when output bytes change.

## Enable Compression

Open **Settings** and configure **Tool result compression**.

Common starting point:

- Mode: `measure_only`
- Minimum original bytes: `512`
- Minimum savings tokens: `0`
- Store original artifact: enabled when you need inspection
- Store compressed artifact: enabled when you need replay evidence

After measurement looks safe, switch to a mutating mode for eligible traffic.

## Preview Compression

Use the console compression preview to test a sample request body or a recorded request. Preview shows:

- Source and surface.
- Whether raw content is available.
- Candidate or measured blocks.
- Rule ID and status.
- Original and compressed byte/token estimates.
- Diff segments when prompt capture allows raw content.

## Inspect Receipts

Compression receipts appear on prompt/request detail pages. Use them to answer:

- Which rule fired?
- How many bytes and estimated tokens were saved?
- Was the result only measured or actually rewritten?
- Is a retrieval marker available?
- Were original and compressed artifacts retained?

## When To Avoid Compression

Avoid mutating compression when:

- Prompt capture policy does not allow enough inspection for rollout.
- Provider behavior changes would be hard to debug.
- Tool output is semantically sensitive to exact formatting.
- You cannot tolerate any risk of cache-prefix drift.

Use `measure_only` first when in doubt.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No receipts appear | Compression disabled, body too small, no eligible tool-result block, or rule skipped |
| Receipts show measured only | Mode is `measure_only` |
| No diff segments | Prompt capture mode does not allow raw content |
| Savings lower than expected | Payload may already be compact, non-JSON, or below thresholds |
| Cache behavior changed | Check deterministic output, duplicate references, and rule version changes |

Deep implementation notes live in [Tool Result Compression Walkthrough](../future/tool-result-compression-walkthrough.md).
