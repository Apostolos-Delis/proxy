import { useId } from "react";
import {
  Area,
  AreaChart as RechartsAreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { formatCompact } from "../format";
import { ChartFrame, EmptyChart, formatChartValue } from "./chartPrimitives";

export type LayeredAreaSeries = {
  key: string;
  label: string;
  color: string;
  /** Filled series get the gradient wash; unfilled ones render as a bare line overlay. */
  filled?: boolean;
};

export type LayeredAreaRow = {
  label: string;
  values: Record<string, number>;
};

/** Overlaid (not stacked) area series sharing one axis and tooltip. */
export function LayeredAreaChart({ data, series, height = 280, valueFormatter, tickFormatter }: {
  data: LayeredAreaRow[];
  series: LayeredAreaSeries[];
  height?: number;
  valueFormatter?: (value: number) => string;
  tickFormatter?: (value: number) => string;
}) {
  const gradientPrefix = `layered-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  if (data.length === 0) return <EmptyChart height={height} />;
  // Axis on the unique index: duplicate labels (24h spans 25 hour buckets) would
  // otherwise make the tooltip resolve the wrong bucket.
  const rows = data.map((row, index) => ({ ...row, index }));

  return (
    <ChartFrame height={height} className="area-chart">
      <RechartsAreaChart data={rows} margin={{ top: 16, right: 10, bottom: 8, left: 4 }}>
        <defs>
          {series.filter((item) => item.filled).map((item) => (
            <linearGradient key={item.key} id={`${gradientPrefix}-${item.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={item.color} stopOpacity={0.24} />
              <stop offset="95%" stopColor={item.color} stopOpacity={0.03} />
            </linearGradient>
          ))}
        </defs>
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
        <Tooltip
          cursor={{ stroke: "var(--border-strong)", strokeWidth: 1, strokeDasharray: "3 3" }}
          content={<LayeredTooltip valueFormatter={valueFormatter} />}
        />
        {series.map((item) => (
          <Area
            key={item.key}
            dataKey={(row: LayeredAreaRow) => row.values[item.key] ?? 0}
            name={item.label}
            type="monotone"
            fill={item.filled ? `url(#${gradientPrefix}-${item.key})` : "transparent"}
            stroke={item.color}
            strokeWidth={item.filled ? 3 : 2}
            activeDot={{ r: 4, fill: item.color, stroke: "var(--bg-0)", strokeWidth: 2 }}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </RechartsAreaChart>
    </ChartFrame>
  );
}

function LayeredTooltip({ active, payload, valueFormatter }: {
  active?: boolean;
  payload?: { name?: string; value?: number; stroke?: string; payload?: LayeredAreaRow }[];
  valueFormatter?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <span>{payload[0]?.payload?.label}</span>
      {payload.map((entry, index) => (
        <em key={index} className="chart-tooltip-series">
          <i style={{ background: entry.stroke }} />
          {entry.name} · {formatChartValue(Number(entry.value ?? 0), valueFormatter)}
        </em>
      ))}
    </div>
  );
}
