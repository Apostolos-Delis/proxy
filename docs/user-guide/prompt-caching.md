# Prompt Caching

Proxy records prompt-cache usage for every provider that reports it, and it can apply a small set of provider-specific cache controls. Today, Proxy-owned cache controls are Anthropic-only. OpenAI caching is provider-managed unless the caller sends native OpenAI cache fields.

Use **Caching** in the console to monitor cache read ratio, cached tokens, uncached input, estimated cache savings, likely cache busts, key/session hit rates, token attribution buckets, compression savings, and idle gaps that could benefit from longer TTLs.

Use the [prompt caching rollout runbook](../runbooks/prompt-caching.md) before enabling or changing mutating cache controls.

## Current Support

| Provider target | Proxy-applied controls | Preserved caller controls | Measurements |
| --- | --- | --- | --- |
| Anthropic Messages | Optional top-level `cache_control`; optional `ttl: "1h"` upgrades | Existing `cache_control` markers are preserved unless the TTL policy upgrades eligible ephemeral markers | Cache reads, cache writes, cache savings, cache busts, token attribution, idle gaps |
| OpenAI Responses | None | `prompt_cache_key` and `prompt_cache_retention` are forwarded to public OpenAI API upstreams when present | Cache reads, cache hit rate, cache savings, token attribution, cache busts |
| OpenAI Chat Completions | None | `prompt_cache_key` and `prompt_cache_retention` are forwarded to public OpenAI API upstreams when present | Cache reads, cache hit rate, cache savings, token attribution, cache busts |
| Translated Anthropic target | Anthropic controls can apply after translation to Anthropic Messages | OpenAI-only cache fields are not copied into Anthropic requests | Anthropic usage is normalized into the same ledger fields |
| Translated OpenAI target | None | Anthropic `cache_control` is not copied into OpenAI requests | OpenAI usage is normalized into the same ledger fields |

## Anthropic Controls

Enable Anthropic cache controls in **Settings -> Token optimization**.

`Auto-enable prompt caching` adds a top-level `cache_control: { "type": "ephemeral" }` to eligible Anthropic Messages requests. Proxy applies it only to multi-turn requests that do not already contain cache breakpoints, so one-shot requests do not pay a cache-write surcharge just because the org setting is on.

`Adapt cache TTL to 1 hour` lets Proxy upgrade eligible ephemeral cache markers to `ttl: "1h"`. The org setting is only one gate. Runtime activates the upgrade after recent workspace usage shows recoverable idle gaps: requests that would likely miss the default 5-minute cache but still fall inside the 1-hour window. Small, one-shot, low-reuse, and unsupported requests stay on the default TTL.

Proxy preserves caller-sent Anthropic cache markers. If a caller already placed a `cache_control` marker, automatic caching does not add another top-level marker. The TTL policy can still upgrade eligible ephemeral markers when the runtime gates pass.

## OpenAI Behavior

OpenAI prompt caching works automatically on supported public OpenAI API models. Proxy does not add OpenAI cache controls on its own today.

When a caller sends native OpenAI fields, Proxy keeps them on public OpenAI API requests:

- `prompt_cache_key` is preserved for native OpenAI requests and can also be used by Proxy session detection for Codex and opencode traffic.
- `prompt_cache_retention` is preserved for native OpenAI Responses and Chat Completions requests.

OpenAI-only cache fields are dropped when the selected target is Anthropic because Anthropic does not accept them. Anthropic `cache_control` markers are dropped when the selected target is OpenAI because OpenAI does not use Anthropic breakpoint syntax.

## What Proxy Measures

Proxy normalizes provider usage into:

- `inputTokens`
- `cachedInputTokens`
- `cacheCreationInputTokens`
- `outputTokens`
- `reasoningTokens`
- `totalTokens`

Those fields feed **Usage / Cost**, **Caching**, request logs, session views, token attribution, and spend accounting. Cache savings are estimates based on local model pricing: cached tokens are compared against the full input-token price for the same model.

Use cache-bust reporting when cache read tokens collapse between adjacent requests in the same session. Current causes include likely TTL expiry, model switch, provider switch, logical-model change, org prompt edit, tool schema churn, translator change, compression policy change, or unknown when evidence is incomplete. Use token attribution when you need to find whether system prompts, org prompts, tool schemas, history, latest user text, or tool results are dominating the uncached prefix.

## Operator Workflow

1. Open **Caching** and check cache read ratio, cached tokens, uncached input, and estimated cache savings for the time window.
2. Check likely cache busts for sessions where cached tokens collapsed.
3. Use key/session hit rates to find whether a workspace, API key, or session identity is getting stable cache locality.
4. Use token attribution to find which request bucket is driving uncached input.
5. For Anthropic traffic, decide whether `Auto-enable prompt caching` or `Adapt cache TTL to 1 hour` matches the observed pattern.
6. For OpenAI traffic, keep static content at the start of prompts, preserve stable `prompt_cache_key` values when callers provide them, and avoid logical-model target or translation changes that move traffic away from a warm provider/model prefix.

## Related Pages

- [Analytics And Spend](analytics.md)
- [Prompt Caching Runbook](../runbooks/prompt-caching.md)
- [Monitoring](monitoring.md)
- [Sessions And Request Replay](sessions.md)
- [Token Compression](token-compression.md)
