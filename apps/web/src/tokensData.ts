import { graphql } from "./gql";
import type { TokenAttributionViewQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import type { UsageGroup, UsageRangeFilters } from "./usageData";

const TokenAttributionViewDocument = graphql(`
  query TokenAttributionView($start: String, $end: String) {
    tokenAttribution(start: $start, end: $end) {
      requestCount
      sampled
      buckets {
        key
        chars
        estimatedTokens
      }
      toolSchemas {
        name
        chars
        estimatedTokens
        blocks
      }
      toolResults {
        name
        chars
        estimatedTokens
        blocks
      }
    }
  }
`);

export type TokenAttributionReport = TokenAttributionViewQuery["tokenAttribution"];
export type TokenAttributionOffender = TokenAttributionReport["toolSchemas"][number];

export async function fetchTokenAttribution(filters: UsageRangeFilters = {}) {
  return (await gqlFetch(TokenAttributionViewDocument, { ...filters })).tokenAttribution;
}

export const bucketLabels: Record<string, string> = {
  systemPrompt: "System prompt",
  orgSystemPrompt: "Org prompt (injected)",
  toolSchemas: "Tool schemas",
  history: "Replayed history",
  newToolResults: "New tool results",
  latestUser: "User messages"
};

// Provider-aware hit rate: Anthropic input_tokens excludes cache reads/writes;
// OpenAI reports cached tokens as a subset of input_tokens. Groups for other
// keys (e.g. the __other__ collapse) are deliberately excluded — their cache
// semantics are unknown, matching the server-side sessions computation.
export function cacheHitRateOf(groups: Pick<UsageGroup, "key" | "usage">[]) {
  let hits = 0;
  let total = 0;
  for (const group of groups) {
    const usage = group.usage;
    if (group.key === "anthropic") {
      hits += usage.cachedInputTokens;
      total += usage.inputTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens;
    } else if (group.key === "openai") {
      hits += usage.cachedInputTokens;
      total += usage.inputTokens;
    }
  }
  return total > 0 ? hits / total : null;
}
