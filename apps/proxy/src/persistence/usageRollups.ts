import { sql, type SQL } from "drizzle-orm";

import type { ProxyDbSession } from "@proxy/db";

// SQL-side aggregation for the usage/cost analytics. The previous
// implementation loaded every request, decision, attempt, and ledger row in
// the window into Node and aggregated in JS, which scaled linearly with
// traffic per GraphQL field. These rollups group inside Postgres and return
// one row per (group, surface, requestedModel[, bucket]) so the transfer and
// JS work stay proportional to the number of groups, not requests.
//
// Rows stay split by (surface, requestedModel) because the baseline cost is
// priced live per that pair (see baselineCostFor); token sums are linear, so
// pricing the per-pair sums equals pricing each request individually.

export type UsageRollupGroupBy =
  | "user"
  | "api_key"
  | "provider"
  | "model"
  | "model_effort"
  | "route"
  | "surface"
  | "session";

export type UsageRollupScope = {
  organizationId: string;
  workspaceId: string;
  start?: Date;
  end?: Date;
};

export type UsageRollupRow = {
  groupKey: string;
  surface: string;
  requestedModel: string;
  selectedProvider?: string;
  selectedModel?: string;
  requestCount: number;
  failedRequests: number;
  retriedRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  // sum of per-request max(0, input - cached - cacheCreation); preserves the
  // per-request clipping in usageCostMicros when baselining summed tokens.
  uncachedInputTokens: number;
  providerCostMicros: number;
  classifierCostMicros: number;
  earliestCreatedAtMs: number;
};

export type UsageBucketRollupRow = UsageRollupRow & { bucketTs: number };

export type UsageLatencyRow = {
  // null on rows aggregated across all groups (grand/bucket totals)
  groupKey: string | null;
  // null on rows aggregated across all buckets (or in the unbucketed variant)
  bucketTs: number | null;
  averageMs: number | null;
  p95Ms: number | null;
};

export type UsageRollupReport = {
  rollups: UsageRollupRow[];
  latencies: UsageLatencyRow[];
};

export type UsageBucketRollupReport = {
  rollups: UsageBucketRollupRow[];
  latencies: UsageLatencyRow[];
};

export type OpenAICacheAnalyticsRow = {
  surface: string;
  provider: string;
  model: string;
  route: string;
  cacheGroupSource: string;
  cacheGroupKey: string;
  requestCount: number;
  cachedRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
};

export type OpenAICacheTrendRow = {
  bucketTs: number;
  requestCount: number;
  cachedRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
};

export type OpenAICacheAnalyticsRows = {
  groups: OpenAICacheAnalyticsRow[];
  trends: OpenAICacheTrendRow[];
};

export type UsageLatencyMode = "full" | "report";

const GROUP_KEY_SQL: Record<UsageRollupGroupBy, string> = {
  user: "coalesce(r.user_id, 'unknown')",
  api_key: "coalesce(r.api_key_id, 'unknown')",
  provider: "coalesce(d.selected_provider, aa.last_provider, 'unknown')",
  model: "coalesce(d.selected_model, aa.last_model, 'unknown')",
  model_effort:
    "case when d.reasoning_effort is not null and d.reasoning_effort <> '' " +
    "then coalesce(d.selected_model, aa.last_model, 'unknown') || ' · ' || d.reasoning_effort " +
    "else coalesce(d.selected_model, aa.last_model, 'unknown') end",
  route: "coalesce(d.final_route, 'unknown')",
  surface: "coalesce(r.surface, 'unknown')",
  session: "coalesce(r.session_id, 'unknown')"
};

export const OTHER_ROLLUP_GROUP_KEY = "__other__";

function keyExpression(groupBy: UsageRollupGroupBy, keptKeys: string[] | null): SQL {
  const raw = sql.raw(GROUP_KEY_SQL[groupBy]);
  if (!keptKeys || keptKeys.length === 0) return raw;
  const keptList = sql.join(keptKeys.map((key) => sql`${key}`), sql`, `);
  return sql`case when ${raw} in (${keptList}) then ${raw} else ${OTHER_ROLLUP_GROUP_KEY} end`;
}

function bucketExpression(stepMs: number): SQL {
  return sql`(floor(extract(epoch from r.created_at) * 1000 / ${stepMs}) * ${stepMs})::double precision`;
}

// Shared CTEs: the window-scoped requests, the latest attempt (plus attempt
// count) per request, and per-request ledger sums. Provider usage rows are the
// attempt-linked ones; classifier rows have no attempt and only contribute
// spend, never tokens.
function requestMetricsCtes(scope: UsageRollupScope, keyExpr: SQL, bucketExpr: SQL | null): SQL {
  const { organizationId, workspaceId, start, end } = scope;
  // Dates travel as ISO strings: raw-sql params skip drizzle's column-level
  // Date serialization and postgres-js does not encode Date objects itself.
  return sql`
    with scoped_requests as (
      select id, user_id, api_key_id, session_id, surface, requested_model, status, created_at
      from requests
      where organization_id = ${organizationId}
        and workspace_id = ${workspaceId}
        ${start ? sql`and created_at >= ${start.toISOString()}` : sql``}
        ${end ? sql`and created_at <= ${end.toISOString()}` : sql``}
    ),
    attempt_agg as (
      select
        pa.request_id,
        count(*)::int as attempt_count,
        (array_agg(pa.terminal_status order by pa.started_at desc))[1] as last_status,
        (array_agg(pa.provider order by pa.started_at desc))[1] as last_provider,
        (array_agg(pa.model order by pa.started_at desc))[1] as last_model,
        (array_agg(pa.started_at order by pa.started_at desc))[1] as last_started_at,
        (array_agg(pa.completed_at order by pa.started_at desc))[1] as last_completed_at
      from provider_attempts pa
      join scoped_requests sr on sr.id = pa.request_id
      where pa.organization_id = ${organizationId}
        and pa.workspace_id = ${workspaceId}
      group by pa.request_id
    ),
    ledger_agg as (
      select
        ul.request_id,
        coalesce(sum(ul.input_tokens) filter (where ul.provider_attempt_id is not null), 0) as input_tokens,
        coalesce(sum(ul.cached_input_tokens) filter (where ul.provider_attempt_id is not null), 0) as cached_input_tokens,
        coalesce(sum(ul.cache_creation_input_tokens) filter (where ul.provider_attempt_id is not null), 0) as cache_creation_input_tokens,
        coalesce(sum(ul.output_tokens) filter (where ul.provider_attempt_id is not null), 0) as output_tokens,
        coalesce(sum(ul.reasoning_tokens) filter (where ul.provider_attempt_id is not null), 0) as reasoning_tokens,
        coalesce(sum(ul.total_tokens) filter (where ul.provider_attempt_id is not null), 0) as total_tokens,
        coalesce(sum(ul.total_cost_micros) filter (where ul.provider_attempt_id is not null), 0) as provider_cost_micros,
        coalesce(sum(ul.total_cost_micros) filter (where ul.kind = 'classifier'), 0) as classifier_cost_micros
      from usage_ledger ul
      join scoped_requests sr on sr.id = ul.request_id
      where ul.organization_id = ${organizationId}
        and ul.workspace_id = ${workspaceId}
      group by ul.request_id
    ),
    request_metrics as (
      select
        ${keyExpr} as group_key,
        ${bucketExpr ? bucketExpr : sql`null::double precision`} as bucket_ts,
        r.surface as surface,
        r.requested_model as requested_model,
        coalesce(d.selected_provider, aa.last_provider) as selected_provider,
        coalesce(d.selected_model, aa.last_model) as selected_model,
        coalesce(aa.last_status, r.status) as terminal_status,
        coalesce(aa.attempt_count, 0) as attempt_count,
        coalesce(la.input_tokens, 0)::double precision as input_tokens,
        coalesce(la.cached_input_tokens, 0)::double precision as cached_input_tokens,
        coalesce(la.cache_creation_input_tokens, 0)::double precision as cache_creation_input_tokens,
        coalesce(la.output_tokens, 0)::double precision as output_tokens,
        coalesce(la.reasoning_tokens, 0)::double precision as reasoning_tokens,
        coalesce(la.total_tokens, 0)::double precision as total_tokens,
        greatest(
          coalesce(la.input_tokens, 0) -
            coalesce(la.cached_input_tokens, 0) -
            coalesce(la.cache_creation_input_tokens, 0),
          0
        )::double precision as uncached_input_tokens,
        coalesce(la.provider_cost_micros, 0)::double precision as provider_cost_micros,
        coalesce(la.classifier_cost_micros, 0)::double precision as classifier_cost_micros,
        floor(extract(epoch from r.created_at) * 1000)::double precision as created_at_ms,
        round(extract(epoch from (aa.last_completed_at - aa.last_started_at)) * 1000)::double precision as latency_ms
      from scoped_requests r
      left join route_decisions d
        on d.request_id = r.id
        and d.organization_id = ${organizationId}
        and d.workspace_id = ${workspaceId}
      left join attempt_agg aa on aa.request_id = r.id
      left join ledger_agg la on la.request_id = r.id
    )
  `;
}

function reportSelect(scope: UsageRollupScope, keyExpr: SQL, bucketExpr: SQL | null, latencyMode: UsageLatencyMode): SQL {
  const bucketed = bucketExpr !== null;
  const bucketedLatency = bucketed && latencyMode === "full";
  return sql`
    ${requestMetricsCtes(scope, keyExpr, bucketExpr)}
    select
      'rollup'::text as row_kind,
      group_key,
      0::int as key_grouped,
      ${bucketed ? sql`bucket_ts` : sql`null::double precision`} as bucket_ts,
      ${bucketed ? sql`0::int` : sql`null::int`} as bucket_grouped,
      surface,
      requested_model,
      selected_provider,
      selected_model,
      count(*)::int as request_count,
      (count(*) filter (where terminal_status = 'failed'))::int as failed_requests,
      (count(*) filter (where attempt_count > 1))::int as retried_requests,
      coalesce(sum(input_tokens), 0)::double precision as input_tokens,
      coalesce(sum(cached_input_tokens), 0)::double precision as cached_input_tokens,
      coalesce(sum(cache_creation_input_tokens), 0)::double precision as cache_creation_input_tokens,
      coalesce(sum(output_tokens), 0)::double precision as output_tokens,
      coalesce(sum(reasoning_tokens), 0)::double precision as reasoning_tokens,
      coalesce(sum(total_tokens), 0)::double precision as total_tokens,
      coalesce(sum(uncached_input_tokens), 0)::double precision as uncached_input_tokens,
      coalesce(sum(provider_cost_micros), 0)::double precision as provider_cost_micros,
      coalesce(sum(classifier_cost_micros), 0)::double precision as classifier_cost_micros,
      min(created_at_ms)::double precision as earliest_created_at_ms,
      null::double precision as average_ms,
      null::double precision as p95_ms
    from request_metrics
    group by ${bucketed
      ? sql.raw("group_key, bucket_ts, surface, requested_model, selected_provider, selected_model")
      : sql.raw("group_key, surface, requested_model, selected_provider, selected_model")}
    union all
    select
      'latency'::text as row_kind,
      group_key,
      grouping(group_key)::int as key_grouped,
      ${bucketedLatency ? sql`bucket_ts` : sql`null::double precision`} as bucket_ts,
      ${bucketedLatency ? sql`grouping(bucket_ts)::int` : sql`null::int`} as bucket_grouped,
      null::text as surface,
      null::text as requested_model,
      null::text as selected_provider,
      null::text as selected_model,
      null::int as request_count,
      null::int as failed_requests,
      null::int as retried_requests,
      null::double precision as input_tokens,
      null::double precision as cached_input_tokens,
      null::double precision as cache_creation_input_tokens,
      null::double precision as output_tokens,
      null::double precision as reasoning_tokens,
      null::double precision as total_tokens,
      null::double precision as uncached_input_tokens,
      null::double precision as provider_cost_micros,
      null::double precision as classifier_cost_micros,
      null::double precision as earliest_created_at_ms,
      (avg(latency_ms) filter (where latency_ms >= 0))::double precision as average_ms,
      (percentile_disc(0.95) within group (order by latency_ms) filter (where latency_ms >= 0))::double precision as p95_ms
    from request_metrics
    group by grouping sets ${bucketedLatency
      ? sql.raw("((group_key), (bucket_ts, group_key), (bucket_ts), ())")
      : sql.raw("((group_key), ())")}
  `;
}

export async function usageRollupReportRows(
  db: ProxyDbSession,
  scope: UsageRollupScope,
  groupBy: UsageRollupGroupBy
): Promise<UsageRollupReport> {
  const rows = await executeRows(db, reportSelect(scope, keyExpression(groupBy, null), null, "full"));
  return splitReportRows(rows, false);
}

export async function usageBucketRollupReportRows(
  db: ProxyDbSession,
  scope: UsageRollupScope,
  groupBy: UsageRollupGroupBy,
  stepMs: number,
  keptKeys: string[] | null,
  latencyMode: UsageLatencyMode = "full"
): Promise<UsageBucketRollupReport> {
  const rows = await executeRows(
    db,
    reportSelect(scope, keyExpression(groupBy, keptKeys), bucketExpression(stepMs), latencyMode)
  );
  return splitReportRows(rows, true);
}

export async function openAICacheAnalyticsRows(
  db: ProxyDbSession,
  scope: UsageRollupScope,
  stepMs: number
): Promise<OpenAICacheAnalyticsRows> {
  const rows = await executeRows(db, openAICacheAnalyticsSelect(scope, bucketExpression(stepMs)));
  const groups: OpenAICacheAnalyticsRow[] = [];
  const trends: OpenAICacheTrendRow[] = [];
  for (const row of rows) {
    if (row.row_kind === "group") {
      groups.push({
        surface: String(row.surface),
        provider: String(row.provider),
        model: String(row.model),
        route: String(row.route),
        cacheGroupSource: String(row.cache_group_source),
        cacheGroupKey: String(row.cache_group_key),
        requestCount: toNumber(row.request_count),
        cachedRequests: toNumber(row.cached_requests),
        inputTokens: toNumber(row.input_tokens),
        cachedInputTokens: toNumber(row.cached_input_tokens)
      });
    } else if (row.row_kind === "trend") {
      trends.push({
        bucketTs: toNumber(row.bucket_ts),
        requestCount: toNumber(row.request_count),
        cachedRequests: toNumber(row.cached_requests),
        inputTokens: toNumber(row.input_tokens),
        cachedInputTokens: toNumber(row.cached_input_tokens)
      });
    }
  }
  return { groups, trends };
}

function openAICacheAnalyticsSelect(scope: UsageRollupScope, bucketExpr: SQL): SQL {
  const { organizationId, workspaceId, start, end } = scope;
  return sql`
    with scoped_requests as (
      select id, session_id, surface, created_at
      from requests
      where organization_id = ${organizationId}
        and workspace_id = ${workspaceId}
        and surface in ('openai-responses', 'openai-chat')
        ${start ? sql`and created_at >= ${start.toISOString()}` : sql``}
        ${end ? sql`and created_at <= ${end.toISOString()}` : sql``}
    ),
    plan_agg as (
      select
        e.scope_id as request_id,
        (array_agg(e.payload->'cacheGroup'->>'source' order by e.created_at desc))[1] as cache_group_source,
        (array_agg(e.payload->'cacheGroup'->>'key' order by e.created_at desc))[1] as cache_group_key
      from events e
      join scoped_requests sr on sr.id = e.scope_id
      where e.organization_id = ${organizationId}
        and e.workspace_id = ${workspaceId}
        and e.event_type = 'prompt_cache.plan_applied'
        and e.payload->>'provider' = 'openai'
      group by e.scope_id
    ),
    request_metrics as (
      select
        r.id as request_id,
        ${bucketExpr} as bucket_ts,
        r.surface as surface,
        coalesce(ul.provider, 'openai') as provider,
        coalesce(ul.model, d.selected_model, 'unknown') as model,
        coalesce(ul.route, d.final_route, 'unknown') as route,
        coalesce(pa.cache_group_source, case when r.session_id is not null then 'session' else 'unknown' end) as cache_group_source,
        coalesce(pa.cache_group_key, r.session_id, 'unknown') as cache_group_key,
        coalesce(sum(ul.input_tokens), 0)::double precision as input_tokens,
        coalesce(sum(ul.cached_input_tokens), 0)::double precision as cached_input_tokens
      from scoped_requests r
      join usage_ledger ul
        on ul.request_id = r.id
        and ul.organization_id = ${organizationId}
        and ul.workspace_id = ${workspaceId}
        and ul.provider_attempt_id is not null
        and ul.provider = 'openai'
      left join route_decisions d
        on d.request_id = r.id
        and d.organization_id = ${organizationId}
        and d.workspace_id = ${workspaceId}
      left join plan_agg pa on pa.request_id = r.id
      group by
        r.id,
        bucket_ts,
        r.surface,
        ul.provider,
        ul.model,
        d.selected_model,
        ul.route,
        d.final_route,
        pa.cache_group_source,
        pa.cache_group_key,
        r.session_id
    ),
    request_totals as (
      select
        request_id,
        bucket_ts,
        coalesce(sum(input_tokens), 0)::double precision as input_tokens,
        coalesce(sum(cached_input_tokens), 0)::double precision as cached_input_tokens
      from request_metrics
      group by request_id, bucket_ts
    )
    select
      'group'::text as row_kind,
      null::double precision as bucket_ts,
      surface,
      provider,
      model,
      route,
      cache_group_source,
      cache_group_key,
      count(*)::int as request_count,
      (count(*) filter (where cached_input_tokens > 0))::int as cached_requests,
      coalesce(sum(input_tokens), 0)::double precision as input_tokens,
      coalesce(sum(cached_input_tokens), 0)::double precision as cached_input_tokens
    from request_metrics
    group by surface, provider, model, route, cache_group_source, cache_group_key
    union all
    select
      'trend'::text as row_kind,
      bucket_ts,
      null::text as surface,
      null::text as provider,
      null::text as model,
      null::text as route,
      null::text as cache_group_source,
      null::text as cache_group_key,
      count(*)::int as request_count,
      (count(*) filter (where cached_input_tokens > 0))::int as cached_requests,
      coalesce(sum(input_tokens), 0)::double precision as input_tokens,
      coalesce(sum(cached_input_tokens), 0)::double precision as cached_input_tokens
    from request_totals
    group by bucket_ts
    order by row_kind, bucket_ts
  `;
}

type RawRow = Record<string, unknown>;

// drizzle's execute() returns a bare row array for postgres-js and a
// { rows } result object for PGlite.
async function executeRows(db: ProxyDbSession, query: SQL): Promise<RawRow[]> {
  const result = await (db as { execute(query: SQL): Promise<unknown> }).execute(query);
  if (Array.isArray(result)) return result as RawRow[];
  return (result as { rows: RawRow[] }).rows;
}

function rollupRow(row: RawRow): UsageRollupRow {
  return {
    groupKey: String(row.group_key),
    surface: String(row.surface),
    requestedModel: String(row.requested_model),
    selectedProvider: stringValue(row.selected_provider),
    selectedModel: stringValue(row.selected_model),
    requestCount: toNumber(row.request_count),
    failedRequests: toNumber(row.failed_requests),
    retriedRequests: toNumber(row.retried_requests),
    inputTokens: toNumber(row.input_tokens),
    cachedInputTokens: toNumber(row.cached_input_tokens),
    cacheCreationInputTokens: toNumber(row.cache_creation_input_tokens),
    outputTokens: toNumber(row.output_tokens),
    reasoningTokens: toNumber(row.reasoning_tokens),
    totalTokens: toNumber(row.total_tokens),
    uncachedInputTokens: toNumber(row.uncached_input_tokens),
    providerCostMicros: toNumber(row.provider_cost_micros),
    classifierCostMicros: toNumber(row.classifier_cost_micros),
    earliestCreatedAtMs: toNumber(row.earliest_created_at_ms)
  };
}

function latencyRow(row: RawRow, bucketed: boolean): UsageLatencyRow {
  const bucketGrouped = row.bucket_grouped;
  return {
    groupKey: toNumber(row.key_grouped) === 1 ? null : String(row.group_key),
    bucketTs: bucketed && bucketGrouped !== null && toNumber(bucketGrouped) === 0 ? toNumber(row.bucket_ts) : null,
    averageMs: row.average_ms === null ? null : toNumber(row.average_ms),
    p95Ms: row.p95_ms === null ? null : toNumber(row.p95_ms)
  };
}

function splitReportRows(rows: RawRow[], bucketed: false): UsageRollupReport;
function splitReportRows(rows: RawRow[], bucketed: true): UsageBucketRollupReport;
function splitReportRows(rows: RawRow[], bucketed: boolean): UsageRollupReport | UsageBucketRollupReport {
  const rollups: (UsageRollupRow | UsageBucketRollupRow)[] = [];
  const latencies: UsageLatencyRow[] = [];
  for (const row of rows) {
    if (row.row_kind === "rollup") {
      const rollup = rollupRow(row);
      rollups.push(bucketed ? { ...rollup, bucketTs: toNumber(row.bucket_ts) } : rollup);
    } else {
      latencies.push(latencyRow(row, bucketed));
    }
  }
  return { rollups, latencies } as UsageRollupReport | UsageBucketRollupReport;
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value !== "" ? value : undefined;
}
