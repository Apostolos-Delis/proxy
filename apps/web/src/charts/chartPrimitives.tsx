import type { ReactNode } from "react";
import { BarChart3 } from "lucide-react";
import { ResponsiveContainer } from "recharts";

export type Point = {
  label: string;
  value: number;
};

export type ChartDatum = Point & {
  index: number;
};

export function ChartFrame({ children, height, className = "", note }: {
  children: ReactNode;
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

export function EmptyChart({ height }: { height: number }) {
  return (
    <div className="chart-frame empty-chart" style={{ height }}>
      <BarChart3 />
      <strong>No request data yet</strong>
      <span>Traffic through the proxy will chart here automatically.</span>
    </div>
  );
}

export function ChartTooltip({ active, payload, label, valueFormatter }: {
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

export function chartData(data: Point[]): ChartDatum[] {
  return data.map((point, index) => ({ ...point, index }));
}

export function miniData(data: Point[] | number[]): ChartDatum[] {
  return data.map((item, index) => {
    if (typeof item === "number") return { label: `${index + 1}`, value: item, index };
    return { ...item, index };
  });
}

export function formatChartValue(value: number, formatter?: (value: number) => string) {
  return formatter ? formatter(value) : new Intl.NumberFormat().format(value);
}
