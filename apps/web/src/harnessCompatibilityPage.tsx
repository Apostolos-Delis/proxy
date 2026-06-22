import { useQuery } from "@tanstack/react-query";
import { Boxes, CheckCircle2, ShieldAlert, Target, Workflow } from "lucide-react";

import { fetchHarnessCompatibilityMatrix, type HarnessCompatibilityRow } from "./harnessCompatibilityData";
import { ConsoleTable, optionItems, uniqueOptionItems, type ConsoleTableColumn, type ConsoleTableFilter } from "./table";
import { Badge, CodePill, GlassCard, PageState, PageTitle } from "./ui";

export function HarnessCompatibilityPage() {
  const { isLoading: queryIsLoading, error: queryError, data: queryData } = useQuery({
    queryKey: ["harness-compatibility-matrix"],
    queryFn: fetchHarnessCompatibilityMatrix
  });

  if (queryIsLoading) return <PageState title="Compatibility" label="Loading compatibility matrix" />;
  if (queryError) return <PageState title="Compatibility" label={queryError.message} />;

  const rows = queryData ?? [];
  const totals = supportTotals(rows);
  return (
    <div className="page page-enter">
      <PageTitle
        title="Harness compatibility"
        subtitle={`${totals.native} native, ${totals.translated} translated, ${totals.blocked} blocked, ${totals.unsupported} unsupported paths`}
      />
      <GlassCard>
        <div className="card-head">
          <div className="card-title"><Workflow />Support states</div>
          <div className="row gap-8">
            <SupportBadge support="native" />
            <SupportBadge support="translated" />
            <SupportBadge support="blocked" />
            <SupportBadge support="unsupported" />
          </div>
        </div>
        <div className="muted">
          Fixture counts and support states come from the backend compatibility report.
        </div>
      </GlassCard>
      <ConsoleTable
        urlState
        data={rows}
        columns={compatibilityColumns}
        search={{ placeholder: "Search harnesses, dialects, blockers...", getValue: compatibilitySearchValue }}
        filters={compatibilityFilters(rows)}
        emptyLabel="No compatibility rows found."
        initialPageSize={25}
        pageSizeOptions={[25, 50, 100]}
      />
    </div>
  );
}

const compatibilityColumns: ConsoleTableColumn<HarnessCompatibilityRow>[] = [
  { id: "harness", header: "Harness", size: 280, accessorFn: (row) => row.displayName, cell: ({ row }) => <HarnessCell row={row.original} /> },
  { id: "surface", header: "Surface", size: 210, accessorFn: (row) => row.surface, cell: ({ row }) => <SurfaceCell row={row.original} /> },
  { id: "target", header: "Provider dialect", size: 190, accessorFn: (row) => row.targetDialect, cell: ({ row }) => <CodePill value={formatDialect(row.original.targetDialect)} /> },
  { id: "support", header: "Support", size: 150, accessorFn: (row) => row.support, cell: ({ row }) => <SupportBadge support={row.original.support} /> },
  { id: "effective", header: "Path", size: 220, accessorFn: effectivePath, cell: ({ row }) => <span className="mono faint">{effectivePath(row.original)}</span> },
  { id: "blockers", header: "Blockers", size: 300, accessorFn: blockerText, cell: ({ row }) => <BlockersCell row={row.original} /> },
  { id: "fixtures", header: "Fixtures", size: 96, accessorFn: (row) => row.testedFixtureCount, cell: ({ row }) => <span className="mono">{row.original.testedFixtureCount}</span> },
  { id: "smoke", header: "Smoke", size: 150, accessorFn: smokeStatus, cell: ({ row }) => <SmokeCell row={row.original} /> }
];

function HarnessCell({ row }: { row: HarnessCompatibilityRow }) {
  return (
    <div>
      <div>{row.displayName}</div>
      <div className="mono faint">{row.profileId}</div>
    </div>
  );
}

function SurfaceCell({ row }: { row: HarnessCompatibilityRow }) {
  return (
    <div className="row gap-8">
      <CodePill value={formatDialect(row.surface)} />
      <Badge>{row.transport}</Badge>
    </div>
  );
}

function SupportBadge({ support }: { support: string }) {
  if (support === "native") return <Badge variant="success" dot>native</Badge>;
  if (support === "translated") return <Badge variant="accent" dot>translated</Badge>;
  if (support === "blocked") return <Badge variant="warn" dot>blocked</Badge>;
  return <Badge variant="danger" dot>unsupported</Badge>;
}

function BlockersCell({ row }: { row: HarnessCompatibilityRow }) {
  const blockers = blockerItems(row);
  if (blockers.length === 0) return <span className="faint">none</span>;
  return (
    <div className="row gap-8 wrap">
      {blockers.map((item) => <Badge key={item} variant={row.support === "unsupported" ? "danger" : "warn"}>{formatReason(item)}</Badge>)}
    </div>
  );
}

function SmokeCell({ row }: { row: HarnessCompatibilityRow }) {
  const status = row.lastSmokeStatus?.status;
  if (!status) return <span className="faint">not run</span>;
  if (status === "passed") return <Badge variant="success" dot>passed</Badge>;
  if (status === "failed") return <Badge variant="danger" dot>failed</Badge>;
  return <Badge variant="warn" dot>{status}</Badge>;
}

function compatibilityFilters(rows: HarnessCompatibilityRow[]): ConsoleTableFilter<HarnessCompatibilityRow>[] {
  return [
    { id: "support", label: "Support", allLabel: "All support", icon: <CheckCircle2 />, options: optionItems(rows.map((row) => row.support)), getValue: (row) => row.support },
    { id: "harness", label: "Harness", allLabel: "All harnesses", icon: <Boxes />, options: uniqueOptionItems(rows.map((row) => ({ value: row.profileId, label: row.displayName }))), getValue: (row) => row.profileId },
    { id: "surface", label: "Surface", allLabel: "All surfaces", icon: <Workflow />, options: optionItems(rows.map((row) => row.surface)), getValue: (row) => row.surface },
    { id: "target", label: "Provider dialect", allLabel: "All dialects", icon: <Target />, options: optionItems(rows.map((row) => row.targetDialect)), getValue: (row) => row.targetDialect },
    { id: "blockers", label: "Blockers", allLabel: "All blockers", icon: <ShieldAlert />, options: optionItems(rows.flatMap((row) => row.reasonCodes)), getValue: (row) => row.reasonCodes }
  ];
}

function compatibilitySearchValue(row: HarnessCompatibilityRow) {
  return [
    row.displayName,
    row.profileId,
    row.harness,
    row.surface,
    row.transport,
    row.targetDialect,
    row.support,
    ...row.reasonCodes,
    ...row.unsupportedStatefulFeatures
  ];
}

function effectivePath(row: HarnessCompatibilityRow) {
  if (row.nativeSupport) return "native";
  if (row.translatedSupport && row.translatedTo) {
    return `${formatDialect(row.translatedFrom)} -> ${formatDialect(row.translatedTo)}`;
  }
  if (row.effectiveDialect) return formatDialect(row.effectiveDialect);
  return "no route";
}

function blockerText(row: HarnessCompatibilityRow) {
  return blockerItems(row).join(" ");
}

function smokeStatus(row: HarnessCompatibilityRow) {
  return row.lastSmokeStatus?.status ?? "not run";
}

function blockerItems(row: HarnessCompatibilityRow) {
  if (row.nativeSupport) return row.reasonCodes;
  return [...row.reasonCodes, ...row.unsupportedStatefulFeatures];
}

function supportTotals(rows: HarnessCompatibilityRow[]) {
  return rows.reduce(
    (totals, row) => ({ ...totals, [row.support]: totals[row.support] + 1 }),
    { native: 0, translated: 0, blocked: 0, unsupported: 0 } as Record<string, number>
  );
}

function formatDialect(value: string) {
  if (value === "openai-responses") return "OpenAI Responses";
  if (value === "openai-chat") return "OpenAI Chat";
  if (value === "anthropic-messages") return "Anthropic Messages";
  return value;
}

function formatReason(value: string) {
  if (value === "stateful_translation_unavailable") return "stateful native only";
  if (value === "previous_response_translation_unavailable") return "prior response native only";
  if (value === "websocket_native_only") return "websocket native only";
  if (value === "translator_unavailable") return "missing translator";
  if (value === "dialect_unavailable") return "missing dialect";
  if (value === "unsupported_field") return "unsupported field";
  if (value === "previous_response_id") return "previous response id";
  if (value === "websocket_transport") return "websocket transport";
  return value;
}
