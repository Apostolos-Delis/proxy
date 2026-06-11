import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { formatCompact } from "../format";
import { ChartFrame, EmptyChart, formatChartValue } from "./chartPrimitives";

export type StackedChartSeries = {
  key: string;
  label: string;
  color: string;
};

export type StackedChartRow = {
  label: string;
  total: number;
  values: Record<string, number>;
};

export function StackedBarsChart({ data, series, height = 280, valueFormatter, tickFormatter, zeroNote }: {
  data: StackedChartRow[];
  series: StackedChartSeries[];
  height?: number;
  valueFormatter?: (value: number) => string;
  tickFormatter?: (value: number) => string;
  zeroNote?: string;
}) {
  if (data.length === 0) return <EmptyChart height={height} />;
  const allZero = data.every((row) => row.total === 0);
  // Sparse windows (7d) leave each bucket very wide; full-width bars there read as blocks.
  const maxBarSize = data.length <= 10 ? 22 : 36;
  // Axis on the unique index, not the label: recharts resolves the hovered tooltip row by
  // axis value, so duplicate labels (24h spans 25 hour buckets) would show the wrong bucket.
  const rows = data.map((row, index) => ({ ...row, index }));

  return (
    <ChartFrame height={height} className="stacked-chart" note={allZero ? zeroNote ?? "Nothing recorded in this window" : undefined}>
      <RechartsBarChart data={rows} margin={{ top: 16, right: 10, bottom: 8, left: 4 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="index"
          tickFormatter={(index: number) => data[index]?.label ?? ""}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          minTickGap={26}
        />
        <YAxis
          width={48}
          tickLine={false}
          axisLine={false}
          tickCount={4}
          domain={[0, "auto"]}
          tickFormatter={tickFormatter ?? formatCompact}
        />
        <Tooltip cursor={{ fill: "var(--glass-hover)" }} content={<StackedTooltip valueFormatter={valueFormatter} />} />
        {series.map((item) => (
          <Bar
            key={item.key}
            stackId="usage"
            dataKey={(row: StackedChartRow) => row.values[item.key] ?? 0}
            name={item.label}
            fill={item.color}
            maxBarSize={maxBarSize}
            isAnimationActive={false}
          />
        ))}
      </RechartsBarChart>
    </ChartFrame>
  );
}

export function ChartLegend({ series }: { series: StackedChartSeries[] }) {
  if (series.length === 0) return null;
  return (
    <div className="chart-series-legend">
      {series.map((item) => (
        <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>
      ))}
    </div>
  );
}

function StackedTooltip({ active, payload, valueFormatter }: {
  active?: boolean;
  payload?: { name?: string; value?: number; fill?: string; payload?: StackedChartRow }[];
  valueFormatter?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  const total = row?.total ?? 0;
  const entries = [...payload].reverse().filter((entry) => Number(entry.value ?? 0) > 0);
  return (
    <div className="chart-tooltip">
      <span>{row?.label}</span>
      <strong>{formatChartValue(total, valueFormatter)}</strong>
      {entries.map((entry, index) => (
        <em key={index} className="chart-tooltip-series">
          <i style={{ background: entry.fill }} />
          {entry.name} · {formatChartValue(Number(entry.value ?? 0), valueFormatter)}
        </em>
      ))}
    </div>
  );
}
