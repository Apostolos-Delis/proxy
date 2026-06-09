/* Proxy — SVG chart components (responsive, animated, hover tooltips) */

const { useState, useRef, useEffect, useCallback, useMemo } = React;

/* ---- format helpers ---- */
function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return Math.round(n).toLocaleString();
}
function fmtUSD(n, dec = 2) {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtInt(n) { return Math.round(n).toLocaleString("en-US"); }

/* ---- measure hook ---- */
function useMeasure() {
  const ref = useRef(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0].contentRect.width;
      if (cw > 0) setW(cw);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/* ============================================================
   BAR CHART — daily values, optional budget line, hover tip
   ============================================================ */
function BarChart({ data, height = 260, fmt = fmtUSD, budget = null, color = "var(--accent)", animate = true }) {
  const [ref, w] = useMeasure();
  const [hover, setHover] = useState(null);
  const [mounted, setMounted] = useState(!animate);
  useEffect(() => { const t = setTimeout(() => setMounted(true), 30); return () => clearTimeout(t); }, []);

  const padB = 26, padT = 12, padL = 4, padR = 4;
  const plotH = height - padB - padT;
  const plotW = Math.max(0, w - padL - padR);
  const max = Math.max(...data.map(d => d.value), budget || 0) * 1.08 || 1;
  const n = data.length;
  const gap = n > 24 ? 0.28 : 0.36;
  const bw = plotW / n;
  const barW = bw * (1 - gap);

  const budgetY = budget != null ? padT + plotH * (1 - budget / max) : null;

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <svg width="100%" height={height} style={{ display: "block", overflow: "visible" }}>
        <defs>
          <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-2)" />
            <stop offset="100%" stopColor="var(--accent)" />
          </linearGradient>
        </defs>
        {/* gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((g, i) => (
          <line key={i} x1={padL} x2={w - padR} y1={padT + plotH * g} y2={padT + plotH * g}
            stroke="var(--grid-line)" strokeWidth="1" />
        ))}
        {/* bars */}
        {data.map((d, i) => {
          const bh = mounted ? plotH * (d.value / max) : 0;
          const x = padL + i * bw + (bw - barW) / 2;
          const y = padT + plotH - bh;
          const isHover = hover === i;
          return (
            <rect key={i} x={x} y={y} width={barW} height={bh} rx={Math.min(4, barW / 3)}
              fill="var(--accent)" opacity={hover == null || isHover ? 1 : 0.38}
              style={{ transition: "height .7s var(--ease), y .7s var(--ease), opacity .15s var(--ease)", transitionDelay: `${i * 12}ms` }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          );
        })}
        {/* budget line */}
        {budget != null && (
          <g>
            <line x1={padL} x2={w - padR} y1={budgetY} y2={budgetY}
              stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.7" />
          </g>
        )}
        {/* x labels (first/last + sparse) */}
        {data.map((d, i) => (
          (i === 0 || i === n - 1 || (n <= 14 && i % 2 === 0)) && (
            <text key={i} x={padL + i * bw + bw / 2} y={height - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontSize="10.5" fill="var(--fg-faint)" fontFamily="var(--font)">{d.label}</text>
          )
        ))}
      </svg>
      {budget != null && (
        <div style={{ position: "absolute", right: 0, top: `${budgetY - 9}px`, fontSize: 11, color: "var(--accent-2)", fontFamily: "var(--mono)" }}>
          {fmt(budget, 0)}
        </div>
      )}
      {hover != null && (
        <div className="chart-tip" style={{ left: `${padL + hover * bw + bw / 2}px`, top: `${padT + plotH * (1 - data[hover].value / max)}px` }}>
          <div className="t-label">{data[hover].label}</div>
          <div className="t-val">{fmt(data[hover].value)}</div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   AREA / LINE CHART — smooth, gradient fill, hover crosshair
   ============================================================ */
function AreaChart({ data, height = 240, fmt = fmtNum, color = "var(--accent)", stroke = 2.4, fill = true, gradId = "areaGrad" }) {
  const [ref, w] = useMeasure();
  const [hover, setHover] = useState(null);
  // draw fully on mount, then enable a CSS-transition reveal (rAF is unreliable in
  // offscreen iframes, so the resting state must be fully visible without it)
  const [prog, setProg] = useState(1);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    setProg(0); setDrawn(false);
    const t = setTimeout(() => { setProg(1); setDrawn(true); }, 40);
    return () => clearTimeout(t);
  }, []);

  const padB = 24, padT = 14, padX = 6;
  const plotH = height - padB - padT;
  const plotW = Math.max(1, w - padX * 2);
  const max = Math.max(...data.map(d => d.value)) * 1.08 || 1;
  const min = Math.min(...data.map(d => d.value)) * 0.92;
  const n = data.length;
  const X = (i) => padX + (plotW * i) / (n - 1);
  const Y = (v) => padT + plotH * (1 - (v - min) / (max - min || 1));

  // smooth path (catmull-rom -> bezier)
  const pts = data.map((d, i) => [X(i), Y(d.value)]);
  function smooth(points) {
    if (points.length < 2) return "";
    let d = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i], p2 = points[i + 1], p3 = points[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  }
  const linePath = smooth(pts);
  const areaPath = linePath + ` L ${X(n - 1)} ${padT + plotH} L ${X(0)} ${padT + plotH} Z`;

  const move = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = Math.round(((x - padX) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }, [plotW, n]);

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <svg width="100%" height={height} style={{ display: "block", overflow: "visible" }}
        onMouseMove={move} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((g, i) => (
          <line key={i} x1={padX} x2={w - padX} y1={padT + plotH * g} y2={padT + plotH * g} stroke="var(--grid-line)" />
        ))}
        {fill && <path d={areaPath} fill={`url(#${gradId})`} opacity={drawn ? 1 : 0} style={{ transition: "opacity .6s var(--ease)" }} />}
        <path d={linePath} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          style={{ strokeDasharray: 2400, strokeDashoffset: drawn ? 0 : 2400, transition: "stroke-dashoffset .9s var(--ease)" }} />
        {hover != null && (
          <g>
            <line x1={X(hover)} x2={X(hover)} y1={padT} y2={padT + plotH} stroke="var(--border-strong)" strokeDasharray="3 3" />
            <circle cx={X(hover)} cy={Y(data[hover].value)} r="5" fill="var(--bg-0)" stroke={color} strokeWidth="2.5" />
          </g>
        )}
        {data.map((d, i) => (
          (i === 0 || i === n - 1 || (n <= 14 && i % 2 === 0)) && (
            <text key={i} x={X(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontSize="10.5" fill="var(--fg-faint)" fontFamily="var(--font)">{d.label}</text>
          )
        ))}
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: `${X(hover)}px`, top: `${Y(data[hover].value)}px` }}>
          <div className="t-label">{data[hover].label}</div>
          <div className="t-val">{fmt(data[hover].value)}</div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   SPARKLINE — tiny inline line, no axes
   ============================================================ */
function Sparkline({ data, width = 120, height = 38, color = "var(--accent)", fill = true }) {
  const vals = data.map(d => (typeof d === "number" ? d : d.value));
  const max = Math.max(...vals), min = Math.min(...vals);
  const n = vals.length;
  const X = (i) => (width * i) / (n - 1);
  const Y = (v) => height - 3 - (height - 6) * ((v - min) / (max - min || 1));
  const path = vals.map((v, i) => `${i === 0 ? "M" : "L"} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const gid = "spk" + useMemo(() => Math.random().toString(36).slice(2, 7), []);
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={`${path} L ${width} ${height} L 0 ${height} Z`} fill={`url(#${gid})`} />}
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={X(n - 1)} cy={Y(vals[n - 1])} r="3" fill={color} />
    </svg>
  );
}

/* ============================================================
   MINI BARS — tiny bar sparkline
   ============================================================ */
function MiniBars({ data, width = 130, height = 40, color = "var(--accent)" }) {
  const vals = data.map(d => (typeof d === "number" ? d : d.value));
  const max = Math.max(...vals) || 1;
  const n = vals.length, bw = width / n;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {vals.map((v, i) => {
        const bh = (height - 2) * (v / max);
        return <rect key={i} x={i * bw + bw * 0.18} y={height - bh} width={bw * 0.64} height={bh} rx="1.5" fill={color} opacity={0.45 + 0.55 * (v / max)} />;
      })}
    </svg>
  );
}

/* ============================================================
   DONUT — model split, hover segment
   ============================================================ */
function Donut({ data, size = 190, thickness = 26, valueKey = "tokens", centerLabel = "tokens", fmt = fmtNum }) {
  const [hover, setHover] = useState(null);
  const [prog, setProg] = useState(0);
  useEffect(() => { const t = setTimeout(() => setProg(1), 40); return () => clearTimeout(t); }, []);
  const total = data.reduce((a, b) => a + b[valueKey], 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const segs = data.map((d) => {
    const frac = d[valueKey] / total;
    const seg = { ...d, frac, dash: circ * frac, off: circ * offset, pct: frac };
    offset += frac;
    return seg;
  });
  const shown = hover != null ? data[hover] : { label: "Total", [valueKey]: total, color: "var(--fg)" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--track)" strokeWidth={thickness} />
          {segs.map((s, i) => (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color}
              strokeWidth={hover === i ? thickness + 4 : thickness}
              strokeDasharray={`${s.dash * prog} ${circ}`} strokeDashoffset={-s.off * prog}
              strokeLinecap="butt" opacity={hover == null || hover === i ? 1 : 0.35}
              style={{ transition: "stroke-dasharray .8s var(--ease), opacity .15s, stroke-width .15s", cursor: "pointer" }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          ))}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.03em" }}>{fmt(shown[valueKey])}</div>
            <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>{hover != null ? shown.label : centerLabel}</div>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, minWidth: 150 }}>
        {segs.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", opacity: hover == null || hover === i ? 1 : 0.5 }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color, flex: "none" }}></span>
            <span style={{ fontSize: 12.5, fontWeight: 500, fontFamily: "var(--mono)", flex: 1 }}>{s.label}</span>
            <span style={{ fontSize: 12.5, color: "var(--fg-faint)" }}>{(s.frac * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { fmtNum, fmtUSD, fmtInt, useMeasure, BarChart, AreaChart, Sparkline, MiniBars, Donut });
