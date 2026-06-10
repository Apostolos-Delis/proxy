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

export function MiniBars({ data, height = 42 }: { data: Point[] | number[]; width?: number; height?: number }) {
  const rows = miniData(data);
  if (rows.length === 0) return <div className="chart-frame mini-bars-chart" style={{ height }} />;

  return (
    <ChartFrame height={height} className="mini-bars-chart">
      <RechartsBarChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap="24%">
        <YAxis hide domain={[0, "dataMax"]} />
        <Bar dataKey="value" radius={[2, 2, 1, 1]} fill="var(--accent)" isAnimationActive={false} />
      </RechartsBarChart>
    </ChartFrame>
  );
}

export function Sparkline({ data, height = 54 }: { data: Point[] | number[]; width?: number; height?: number }) {
  const rows = miniData(data);
  if (rows.length === 0) return <div className="chart-frame sparkline" style={{ height }} />;

  return (
    <ChartFrame height={height} className="sparkline">
      <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Line dataKey="value" type="monotone" dot={false} strokeWidth={2.4} isAnimationActive={false} />
      </LineChart>
    </ChartFrame>
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
