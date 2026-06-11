import {
  Area,
  AreaChart as RechartsAreaChart,
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { formatCompact } from "../format";
import { ChartFrame, ChartTooltip, EmptyChart, chartData, formatChartValue, miniData, type ChartDatum, type Point } from "./chartPrimitives";

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
