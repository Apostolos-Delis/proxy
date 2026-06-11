import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { formatCompact } from "../format";
import { ChartFrame, EmptyChart, chartData, formatChartValue, type Point } from "./chartPrimitives";

export function SpendBaselineChart({ data, baseline, height = 300, valueFormatter, tickFormatter, zeroNote }: {
  data: Point[];
  baseline: Point[];
  height?: number;
  valueFormatter?: (value: number) => string;
  tickFormatter?: (value: number) => string;
  zeroNote?: string;
}) {
  const rows = chartData(data).map((row, index) => ({ ...row, baseline: baseline[index]?.value ?? 0 }));
  if (rows.length === 0) return <EmptyChart height={height} />;
  const hasBaseline = rows.some((row) => row.baseline > 0);
  const allZero = rows.every((row) => row.value === 0 && row.baseline === 0);

  return (
    <ChartFrame height={height} className="spend-chart" note={allZero ? zeroNote ?? "Nothing recorded in this window" : undefined}>
      <ComposedChart data={rows} margin={{ top: 16, right: 10, bottom: 8, left: 4 }} barCategoryGap="28%">
        <defs>
          <linearGradient id="proxy-bar-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.95} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.45} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={26} />
        <YAxis
          width={48}
          tickLine={false}
          axisLine={false}
          tickCount={4}
          domain={[0, "auto"]}
          tickFormatter={tickFormatter ?? formatCompact}
        />
        <Tooltip cursor={{ fill: "var(--glass-hover)" }} content={<SpendTooltip valueFormatter={valueFormatter} />} />
        <Bar dataKey="value" radius={[4, 4, 2, 2]} fill="url(#proxy-bar-fill)" maxBarSize={36} className="chart-cell" />
        {hasBaseline ? (
          <Line dataKey="baseline" type="stepAfter" dot={false} strokeWidth={1.5} isAnimationActive={false} className="baseline-line" />
        ) : null}
      </ComposedChart>
    </ChartFrame>
  );
}

function SpendTooltip({ active, payload, label, valueFormatter }: {
  active?: boolean;
  payload?: { payload?: { value: number; baseline: number } }[];
  label?: string;
  valueFormatter?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload;
  if (!datum) return null;
  const saved = datum.baseline - datum.value;
  return (
    <div className="chart-tooltip">
      <span>{label}</span>
      <strong>{formatChartValue(datum.value, valueFormatter)}</strong>
      {datum.baseline > 0 ? (
        <em className="chart-tooltip-baseline">
          {formatChartValue(datum.baseline, valueFormatter)} baseline · {formatChartValue(saved, valueFormatter)} saved
        </em>
      ) : null}
    </div>
  );
}
