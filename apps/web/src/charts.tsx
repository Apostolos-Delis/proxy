import {
  Area,
  AreaChart as RechartsAreaChart,
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

type Point = {
  label: string;
  value: number;
};

type ChartDatum = Point & {
  index: number;
};

export type ChartSelection = {
  point: Point;
  index: number;
};

type InteractiveChartProps = {
  selectedIndex?: number;
  onSelect?: (selection: ChartSelection) => void;
  valueFormatter?: (value: number) => string;
};

export function BarChart({
  data,
  height = 300,
  budget,
  selectedIndex,
  onSelect,
  valueFormatter
}: {
  data: Point[];
  height?: number;
  budget?: number;
} & InteractiveChartProps) {
  const rows = chartData(data);
  if (rows.length === 0) return <EmptyChart height={height} />;

  return (
    <ChartFrame height={height}>
      <RechartsBarChart data={rows} margin={{ top: 16, right: 10, bottom: 8, left: 4 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis hide domain={[0, "dataMax"]} />
        <Tooltip cursor={{ fill: "var(--glass-hover)" }} content={<ChartTooltip valueFormatter={valueFormatter} />} />
        {budget === undefined ? null : <ReferenceLine y={budget} className="budget-line" label={{ value: `$${Math.round(budget)}`, position: "right", className: "budget-label" }} />}
        <Bar dataKey="value" radius={[4, 4, 2, 2]} onClick={(datum) => selectDatum(datum, onSelect)}>
          {rows.map((row) => (
            <Cell key={`${row.label}-${row.index}`} className={selectedIndex === row.index ? "chart-cell selected" : "chart-cell"} />
          ))}
        </Bar>
      </RechartsBarChart>
    </ChartFrame>
  );
}

export function MiniBars({ data, height = 42 }: { data: Point[] | number[]; width?: number; height?: number }) {
  const rows = miniData(data);
  if (rows.length === 0) return <div className="chart-frame mini-bars-chart" style={{ height }} />;

  return (
    <ChartFrame height={height} className="mini-bars-chart">
      <RechartsBarChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap="24%">
        <YAxis hide domain={[0, "dataMax"]} />
        <Bar dataKey="value" radius={[2, 2, 1, 1]} isAnimationActive={false} />
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
  selectedIndex,
  onSelect,
  valueFormatter
}: {
  data: Point[];
  height?: number;
} & InteractiveChartProps) {
  const rows = chartData(data);
  if (rows.length === 0) return <EmptyChart height={height} />;
  const selectedPoint = selectedIndex === undefined ? undefined : rows[selectedIndex];

  return (
    <ChartFrame height={height} className="area-chart">
      <RechartsAreaChart data={rows} margin={{ top: 16, right: 10, bottom: 8, left: 4 }} onClick={(event) => selectActive(event, onSelect)}>
        <defs>
          <linearGradient id="proxy-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.24} />
            <stop offset="95%" stopColor="var(--accent)" stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Tooltip cursor={{ stroke: "var(--accent-2)", strokeWidth: 1 }} content={<ChartTooltip valueFormatter={valueFormatter} />} />
        <Area dataKey="value" type="monotone" fill="url(#proxy-area-fill)" stroke="var(--accent)" strokeWidth={3} activeDot={{ r: 5 }} dot={false} />
        {selectedPoint ? <ReferenceDot x={selectedPoint.label} y={selectedPoint.value} r={5} className="selected-area-dot" /> : null}
      </RechartsAreaChart>
    </ChartFrame>
  );
}

function ChartFrame({ children, height, className = "" }: { children: React.ReactNode; height: number; className?: string }) {
  return (
    <div className={`chart-frame ${className}`} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

function EmptyChart({ height }: { height: number }) {
  return (
    <div className="chart-frame empty-chart" style={{ height }}>
      <span>No request data yet</span>
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

function selectDatum(datum: unknown, onSelect?: (selection: ChartSelection) => void) {
  const row = isChartDatum(datum) ? datum : undefined;
  if (!row) return;
  onSelect?.({ point: { label: row.label, value: row.value }, index: row.index });
}

function selectActive(event: unknown, onSelect?: (selection: ChartSelection) => void) {
  if (!isActiveChartEvent(event)) return;
  selectDatum(event.activePayload[0]?.payload, onSelect);
}

function isChartDatum(value: unknown): value is ChartDatum {
  return value !== null &&
    typeof value === "object" &&
    "label" in value &&
    "value" in value &&
    "index" in value &&
    typeof (value as ChartDatum).label === "string" &&
    typeof (value as ChartDatum).value === "number" &&
    typeof (value as ChartDatum).index === "number";
}

function isActiveChartEvent(value: unknown): value is { activePayload: { payload: unknown }[] } {
  return value !== null &&
    typeof value === "object" &&
    "activePayload" in value &&
    Array.isArray((value as { activePayload?: unknown }).activePayload);
}

function formatChartValue(value: number, formatter?: (value: number) => string) {
  return formatter ? formatter(value) : new Intl.NumberFormat().format(value);
}
