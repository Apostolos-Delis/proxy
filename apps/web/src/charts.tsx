import { BarChart3 } from "lucide-react";
import {
  Area,
  AreaChart as RechartsAreaChart,
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { formatCompact } from "./format";

type Point = {
  label: string;
  value: number;
};

type ChartDatum = Point & {
  index: number;
};

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

type StackedChartSeries = {
  key: string;
  label: string;
  color: string;
};

type StackedChartRow = {
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

type MiniChartProps = {
  data: Point[] | number[];
  width?: number;
  height?: number;
  valueFormatter?: (value: number) => string;
};

export function MiniBars({ data, height = 42, valueFormatter }: MiniChartProps) {
  const rows = miniData(data);
  if (rows.length === 0) return <div className="chart-frame mini-bars-chart" style={{ height }} />;

  return (
    <ChartFrame height={height} className="mini-bars-chart">
      <RechartsBarChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap="24%">
        <YAxis hide domain={[0, "dataMax"]} />
        <Tooltip
          cursor={{ fill: "var(--accent-soft)" }}
          isAnimationActive={false}
          allowEscapeViewBox={{ x: false, y: true }}
          wrapperStyle={{ zIndex: 5 }}
          content={<MiniTooltip valueFormatter={valueFormatter} />}
        />
        <Bar dataKey="value" radius={[2, 2, 1, 1]} fill="var(--accent)" isAnimationActive={false} />
      </RechartsBarChart>
    </ChartFrame>
  );
}

export function Sparkline({ data, height = 54, valueFormatter }: MiniChartProps) {
  const rows = miniData(data);
  if (rows.length === 0) return <div className="chart-frame sparkline" style={{ height }} />;

  return (
    <ChartFrame height={height} className="sparkline">
      <LineChart data={rows} margin={{ top: 6, right: 6, bottom: 6, left: 6 }}>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)", strokeWidth: 1, strokeDasharray: "3 3" }}
          isAnimationActive={false}
          allowEscapeViewBox={{ x: false, y: true }}
          wrapperStyle={{ zIndex: 5 }}
          content={<MiniTooltip valueFormatter={valueFormatter} />}
        />
        <Line
          dataKey="value"
          type="monotone"
          dot={false}
          strokeWidth={2.4}
          isAnimationActive={false}
          activeDot={{ r: 3.5, fill: "var(--accent)", stroke: "var(--bg-0)", strokeWidth: 2 }}
        />
      </LineChart>
    </ChartFrame>
  );
}

function MiniTooltip({ active, payload, valueFormatter }: {
  active?: boolean;
  payload?: { value?: number; payload?: ChartDatum }[];
  valueFormatter?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const value = Number(entry?.value ?? 0);
  const label = entry?.payload?.label;
  return (
    <div className="mini-tooltip">
      <strong>{formatChartValue(value, valueFormatter)}</strong>
      {label ? <span>{label}</span> : null}
    </div>
  );
}

export function AreaChart({
  data,
  height = 310,
  valueFormatter,
  tickFormatter
}: {
  data: Point[];
  height?: number;
  valueFormatter?: (value: number) => string;
  tickFormatter?: (value: number) => string;
}) {
  const rows = chartData(data);
  if (rows.length === 0) return <EmptyChart height={height} />;

  return (
    <ChartFrame height={height} className="area-chart">
      <RechartsAreaChart data={rows} margin={{ top: 16, right: 10, bottom: 8, left: 4 }}>
        <defs>
          <linearGradient id="proxy-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.24} />
            <stop offset="95%" stopColor="var(--accent)" stopOpacity={0.03} />
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
        <Tooltip cursor={{ stroke: "var(--accent-2)", strokeWidth: 1 }} content={<ChartTooltip valueFormatter={valueFormatter} />} />
        <Area dataKey="value" type="monotone" fill="url(#proxy-area-fill)" stroke="var(--accent)" strokeWidth={3} activeDot={{ r: 5 }} dot={false} />
      </RechartsAreaChart>
    </ChartFrame>
  );
}

function ChartFrame({ children, height, className = "", note }: {
  children: React.ReactNode;
  height: number;
  className?: string;
  note?: string;
}) {
  return (
    <div className={`chart-frame ${className}`} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
      {note ? <div className="chart-zero-note">{note}</div> : null}
    </div>
  );
}

function EmptyChart({ height }: { height: number }) {
  return (
    <div className="chart-frame empty-chart" style={{ height }}>
      <BarChart3 />
      <strong>No request data yet</strong>
      <span>Traffic through the proxy will chart here automatically.</span>
    </div>
  );
}

function ChartTooltip({ active, payload, label, valueFormatter }: {
  active?: boolean;
  payload?: { value?: number }[];
  label?: string;
  valueFormatter?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const value = Number(payload[0]?.value ?? 0);
  return (
    <div className="chart-tooltip">
      <span>{label}</span>
      <strong>{formatChartValue(value, valueFormatter)}</strong>
    </div>
  );
}

function chartData(data: Point[]): ChartDatum[] {
  return data.map((point, index) => ({ ...point, index }));
}

function miniData(data: Point[] | number[]): ChartDatum[] {
  return data.map((item, index) => {
    if (typeof item === "number") return { label: `${index + 1}`, value: item, index };
    return { ...item, index };
  });
}

function formatChartValue(value: number, formatter?: (value: number) => string) {
  return formatter ? formatter(value) : new Intl.NumberFormat().format(value);
}
