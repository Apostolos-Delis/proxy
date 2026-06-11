import { useState } from "react";

export type DonutDatum = {
  key: string;
  label: string;
  value: number;
  color: string;
};

export function DonutChart({ data, size = 190, thickness = 26, centerLabel, valueFormatter, emptyLabel = "No data in this window." }: {
  data: DonutDatum[];
  size?: number;
  thickness?: number;
  centerLabel: string;
  valueFormatter: (value: number) => string;
  emptyLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = data.reduce((sum, datum) => sum + datum.value, 0);
  if (total <= 0) return <div className="empty compact-empty">{emptyLabel}</div>;

  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const segments = data.map((datum) => {
    const fraction = datum.value / total;
    const segment = { ...datum, fraction, dash: circumference * fraction, start: circumference * offset };
    offset += fraction;
    return segment;
  });
  const shown = hover === null ? null : segments[hover];

  return (
    <div className="donut-chart">
      <div className="donut-figure" style={{ width: size, height: size }}>
        <svg width={size} height={size} role="img" aria-label={`${centerLabel} by segment`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--track)" strokeWidth={thickness} />
          {segments.map((segment, index) => (
            <circle
              key={segment.key}
              className="donut-seg"
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={segment.color}
              strokeWidth={hover === index ? thickness + 4 : thickness}
              strokeDasharray={`${segment.dash} ${circumference}`}
              strokeDashoffset={-segment.start}
              opacity={hover === null || hover === index ? 1 : 0.35}
              onMouseEnter={() => setHover(index)}
              onMouseLeave={() => setHover(null)}
            />
          ))}
        </svg>
        <div className="donut-center">
          <div>
            <strong>{valueFormatter(shown ? shown.value : total)}</strong>
            <span title={shown?.label}>{shown ? shown.label : centerLabel}</span>
          </div>
        </div>
      </div>
      <div className="donut-legend">
        {segments.map((segment, index) => (
          <div
            key={segment.key}
            className={`donut-legend-row${hover !== null && hover !== index ? " dim" : ""}`}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          >
            <i style={{ background: segment.color }} />
            <span className="mono">{segment.label}</span>
            <em>{Math.round(segment.fraction * 100)}%</em>
          </div>
        ))}
      </div>
    </div>
  );
}
