import { gt, sql } from "drizzle-orm";

import { usageLedger, type PromptProxyDbSession } from "@prompt-proxy/db";

// Rows ingested before normalizeUsage existed carry Anthropic's wire shape:
// input_tokens EXCLUSIVE of the cache_read/cache_creation counts. Under the
// normalized convention (cache reads/writes are subsets of inputTokens) those
// rows are impossible — hit rates blow past 100% and "uncached input" math
// goes negative across the console. Fold the cache counts back into
// input/total where the violation is provable (reads + writes exceed input).
// Exclusive-shape rows whose cache traffic stayed below their fresh input are
// indistinguishable from healthy rows and are left as ingested. Cost columns
// keep their ingest snapshot, matching repriceZeroCostUsage's rule that
// priced rows never reprice. Folding makes the condition unsatisfiable, so
// boot re-runs are no-ops.
export async function normalizeLegacyCachedUsage(db: PromptProxyDbSession) {
  const cacheTokens = sql`${usageLedger.cachedInputTokens} + ${usageLedger.cacheCreationInputTokens}`;
  const healed = await db
    .update(usageLedger)
    .set({
      inputTokens: sql`${usageLedger.inputTokens} + ${cacheTokens}`,
      totalTokens: sql`${usageLedger.totalTokens} + ${cacheTokens}`
    })
    .where(gt(cacheTokens, usageLedger.inputTokens))
    .returning();
  return healed.length;
}
