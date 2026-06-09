/* Proxy — Overview + Usage (3 hero variations) */

const D = window.PROXY_DATA;

function sliceRange(series, range) {
  if (range === "7d") return series.slice(-7);
  return series; // 30d / 90d use full mock series
}
function sumOf(series) { return series.reduce((a, b) => a + b.value, 0); }

/* ============================================================
   OVERVIEW
   ============================================================ */
function OverviewPage() {
  const [range, setRange] = useState("7d");
  const spend = sliceRange(D.spendSeries, range);
  const tokens = sliceRange(D.tokenSeries, range);
  const reqs = sliceRange(D.reqSeries, range);
  const tSpend = sumOf(spend), tTok = sumOf(tokens), tReq = sumOf(reqs);
  const monthSpend = sumOf(D.spendSeries);
  const budgetPct = Math.min(100, (monthSpend / D.monthBudget) * 100);

  return (
    <div className="page page-enter">
      <div className="row gap-12" style={{ justifyContent: "space-between", marginBottom: 22, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.03em" }}>Good evening, Apostolos</div>
          <div className="muted nowrap" style={{ fontSize: 13.5, marginTop: 3 }}>Here's what's happening across Proxy Labs.</div>
        </div>
        <div className="row gap-8">
          <button className="btn"><Icon name="key" size={15} />Get API key</button>
          <button className="btn btn-primary"><Icon name="sparkles" size={15} />New deployment</button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid" style={{ gridTemplateColumns: "1.1fr 1fr 1fr", marginBottom: 18 }}>
        <GlassCard>
          <div className="card-head">
            <div className="card-title"><Icon name="zap" />Total tokens</div>
            <Delta value={18.4} />
          </div>
          <div className="stat-value">{fmtNum(tTok)}</div>
          <div style={{ marginTop: 14 }}><Sparkline data={tokens} width={360} height={48} color="var(--accent-2)" /></div>
        </GlassCard>
        <GlassCard>
          <div className="card-head">
            <div className="card-title"><Icon name="send" />Requests</div>
            <Delta value={9.1} />
          </div>
          <div className="stat-value">{fmtInt(tReq)}</div>
          <div style={{ marginTop: 14 }}><MiniBars data={reqs} width={260} height={48} color="var(--accent)" /></div>
        </GlassCard>
        <GlassCard>
          <div className="card-head">
            <div className="card-title"><Icon name="dollar" />Spend</div>
            <Delta value={-4.2} />
          </div>
          <div className="stat-value">{fmtUSD(tSpend, 0)}</div>
          <div style={{ marginTop: 14 }}><Sparkline data={spend} width={260} height={48} color="#38bdf8" /></div>
        </GlassCard>
      </div>

      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 14 }}><RangePills value={range} onChange={setRange} /></div>

      {/* main split */}
      <div className="grid" style={{ gridTemplateColumns: "1.7fr 1fr" }}>
        <GlassCard>
          <div className="card-head">
            <div className="card-title"><Icon name="usage" />Request volume</div>
            <span className="muted" style={{ fontSize: 12.5 }}>{fmtInt(tReq)} requests · {range}</span>
          </div>
          <AreaChart data={reqs} height={250} fmt={fmtInt} color="var(--accent)" gradId="ovArea" />
        </GlassCard>

        <GlassCard style={{ display: "flex", flexDirection: "column" }}>
          <div className="card-head">
            <div className="card-title"><Icon name="dollar" />June spend</div>
          </div>
          <div className="stat-value" style={{ fontSize: 26 }}>{fmtUSD(monthSpend)}</div>
          <div className="stat-sub">of {fmtUSD(D.monthBudget, 0)} monthly budget</div>
          <div className="meter" style={{ marginTop: 12 }}><i style={{ width: budgetPct + "%" }} /></div>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
            <span className="faint" style={{ fontSize: 11.5 }}>{budgetPct.toFixed(0)}% used</span>
            <span className="badge-accent badge" style={{ fontSize: 11 }}>{fmtUSD(D.monthBudget - monthSpend, 0)} left</span>
          </div>
          <div className="sep" />
          <div className="card-title" style={{ marginBottom: 12 }}><Icon name="cube" />Top models</div>
          <div className="barlist">
            {D.modelSplit.slice(0, 4).map((m, i) => {
              const max = D.modelSplit[0].tokens;
              return (
                <div key={i} className="barlist-row">
                  <div className="barlist-label"><span style={{ width: 8, height: 8, borderRadius: 2, background: m.color }} /><span className="mono">{m.label}</span></div>
                  <div className="barlist-val">{fmtNum(m.tokens)}</div>
                  <div className="barlist-track"><i style={{ width: (m.tokens / max) * 100 + "%", background: m.color }} /></div>
                </div>
              );
            })}
          </div>
        </GlassCard>
      </div>

      {/* updates + models */}
      <div className="grid" style={{ gridTemplateColumns: "1.7fr 1fr", marginTop: 18 }}>
        <div>
          <div className="card-title" style={{ marginBottom: 12, paddingLeft: 4 }}><Icon name="cube" />Recommended models</div>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {D.MODELS.map((m, i) => (
              <GlassCard key={i} className="glass-hoverable" style={{ padding: 18, cursor: "pointer" }}>
                <div className="row gap-12" style={{ marginBottom: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, display: "grid", placeItems: "center", background: m.color + "22", color: m.color }}>
                    <Icon name="cube" size={19} />
                  </div>
                  <div className="mono" style={{ fontWeight: 600, fontSize: 13.5 }}>{m.label}</div>
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>${m.inPrice}/M in · ${m.outPrice}/M out</div>
              </GlassCard>
            ))}
          </div>
        </div>
        <div>
          <div className="card-title" style={{ marginBottom: 12, paddingLeft: 4 }}><Icon name="sparkles" />What's new</div>
          <div className="grid" style={{ gap: 12 }}>
            {D.UPDATES.map((u, i) => (
              <GlassCard key={i} style={{ padding: 16 }}>
                <div className="row gap-8" style={{ marginBottom: 6 }}>
                  <Badge variant="accent">{u.tag}</Badge>
                  <span className="faint" style={{ fontSize: 11.5 }}>{u.date}</span>
                </div>
                <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 4 }}>{u.title}</div>
                <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{u.body}</div>
              </GlassCard>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   USAGE — 3 variations
   ============================================================ */
const METRICS = [
  { key: "spend", label: "Spend", fmt: (v) => fmtUSD(v, v < 100 ? 2 : 0), color: "var(--accent)", icon: "dollar" },
  { key: "tokens", label: "Tokens", fmt: fmtNum, color: "var(--accent-2)", icon: "zap" },
  { key: "requests", label: "Requests", fmt: fmtInt, color: "#38bdf8", icon: "send" },
];

function UsagePage() {
  const [variant, setVariant] = useState("A");
  const [range, setRange] = useState("30d");
  const [metric, setMetric] = useState("spend");

  const seriesMap = {
    spend: sliceRange(D.spendSeries, range),
    tokens: sliceRange(D.tokenSeries, range),
    requests: sliceRange(D.reqSeries, range),
  };
  const totals = {
    spend: sumOf(seriesMap.spend),
    tokens: sumOf(seriesMap.tokens),
    requests: sumOf(seriesMap.requests),
  };
  const M = METRICS.find(m => m.key === metric);
  const monthSpend = sumOf(D.spendSeries);

  const shared = { range, setRange, metric, setMetric, seriesMap, totals, M, monthSpend };

  return (
    <div className="page page-enter">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div className="row gap-8" style={{ flexWrap: "wrap" }}>
          <div className="chip active"><Icon name="cube" size={14} />Default project<Icon name="x" size={13} /></div>
          <div className="chip"><Icon name="calendar" size={14} />May 9 – Jun 8, 2026<Icon name="chevronDown" size={13} /></div>
        </div>
        <div className="row gap-8">
          <span className="faint" style={{ fontSize: 11.5, alignSelf: "center" }}>Layout</span>
          <Segmented accent options={[{ value: "A", label: "Console" }, { value: "B", label: "Grid" }, { value: "C", label: "Focus" }]} value={variant} onChange={setVariant} />
          <button className="btn btn-icon" title="Refresh"><Icon name="refresh" size={16} /></button>
          <button className="btn btn-icon" title="Export"><Icon name="download" size={16} /></button>
        </div>
      </div>

      {variant === "A" && <UsageConsole {...shared} />}
      {variant === "B" && <UsageGrid {...shared} />}
      {variant === "C" && <UsageFocus {...shared} />}
    </div>
  );
}

/* ---------- Variation A: Console (bar + right rail) ---------- */
function UsageConsole({ range, setRange, seriesMap, totals, monthSpend }) {
  const [tab, setTab] = useState("users");
  const budgetPct = Math.min(100, (monthSpend / D.monthBudget) * 100);
  const topUsers = [...D.USERS].sort((a, b) => b.spend - a.spend).slice(0, 6);
  const maxUser = topUsers[0].spend;

  return (
    <div className="grid" style={{ gridTemplateColumns: "1.9fr 1fr", alignItems: "start" }}>
      <GlassCard>
        <div className="card-head">
          <div>
            <div className="card-title" style={{ marginBottom: 6 }}>Total spend</div>
            <div className="stat-value">{fmtUSD(totals.spend)}</div>
            <div className="row gap-8" style={{ marginTop: 6 }}><Delta value={12.6} /><span className="faint nowrap" style={{ fontSize: 12 }}>vs previous {range}</span></div>
          </div>
          <RangePills value={range} onChange={setRange} />
        </div>
        <BarChart data={seriesMap.spend} height={300} fmt={(v) => fmtUSD(v, 0)} budget={D.monthBudget / seriesMap.spend.length} />
        <div className="sep" />
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 0 }}>
          {[["Tokens", fmtNum(totals.tokens), "zap"], ["Requests", fmtInt(totals.requests), "send"], ["Avg / request", fmtUSD(totals.spend / totals.requests, 4), "dollar"]].map((s, i) => (
            <div key={i} style={{ paddingLeft: i ? 20 : 0, borderLeft: i ? "1px solid var(--border)" : "none" }}>
              <div className="card-title" style={{ fontSize: 12 }}><Icon name={s[2]} size={14} />{s[0]}</div>
              <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 4 }}>{s[1]}</div>
            </div>
          ))}
        </div>
      </GlassCard>

      <div className="grid" style={{ gap: 18 }}>
        <GlassCard>
          <div className="card-title">June spend</div>
          <div className="stat-value" style={{ fontSize: 26, marginTop: 6 }}>{fmtUSD(monthSpend)}</div>
          <div className="meter" style={{ marginTop: 12 }}><i style={{ width: budgetPct + "%" }} /></div>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
            <span className="faint nowrap" style={{ fontSize: 11.5 }}>{fmtUSD(D.monthBudget, 0)} budget</span>
            <a className="mono nowrap" style={{ fontSize: 11.5, color: "var(--accent-2)", textDecoration: "none", cursor: "pointer" }}>Manage alerts ↗</a>
          </div>
        </GlassCard>

        <GlassCard>
          <div className="tabs" style={{ marginBottom: 16 }}>
            {[["users", "Users"], ["models", "Models"], ["keys", "API keys"]].map(t => (
              <button key={t[0]} className={tab === t[0] ? "active" : ""} onClick={() => setTab(t[0])}>{t[1]}</button>
            ))}
          </div>
          {tab === "users" && (
            <div className="barlist">
              {topUsers.map((u, i) => (
                <div key={i} className="barlist-row">
                  <div className="barlist-label"><Avatar {...u} size={20} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</span></div>
                  <div className="barlist-val">{fmtUSD(u.spend, 0)}</div>
                  <div className="barlist-track"><i style={{ width: (u.spend / maxUser) * 100 + "%" }} /></div>
                </div>
              ))}
            </div>
          )}
          {tab === "models" && (
            <div className="barlist">
              {D.modelSplit.map((m, i) => (
                <div key={i} className="barlist-row">
                  <div className="barlist-label"><span style={{ width: 8, height: 8, borderRadius: 2, background: m.color }} /><span className="mono">{m.label}</span></div>
                  <div className="barlist-val">{fmtNum(m.tokens)}</div>
                  <div className="barlist-track"><i style={{ width: (m.tokens / D.modelSplit[0].tokens) * 100 + "%", background: m.color }} /></div>
                </div>
              ))}
            </div>
          )}
          {tab === "keys" && (
            <div className="barlist">
              {[...D.KEYS].sort((a, b) => b.spend - a.spend).slice(0, 6).map((k, i) => (
                <div key={i} className="barlist-row">
                  <div className="barlist-label"><Icon name="key" size={13} style={{ color: "var(--fg-faint)" }} /><span className="mono">{k.name}</span></div>
                  <div className="barlist-val">{fmtUSD(k.spend, 0)}</div>
                  <div className="barlist-track"><i style={{ width: (k.spend / 6000) * 100 + "%" }} /></div>
                </div>
              ))}
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
}

/* ---------- Variation B: Grid (KPI cards + combined chart) ---------- */
function UsageGrid({ range, setRange, metric, setMetric, seriesMap, totals, M }) {
  const topUsers = [...D.USERS].sort((a, b) => b.spend - a.spend).slice(0, 5);
  const maxUser = topUsers[0].spend;
  const kpis = [
    { label: "Spend", val: fmtUSD(totals.spend, 0), delta: 12.6, data: seriesMap.spend, color: "var(--accent)", type: "spark" },
    { label: "Tokens", val: fmtNum(totals.tokens), delta: 18.4, data: seriesMap.tokens, color: "var(--accent-2)", type: "bars" },
    { label: "Requests", val: fmtInt(totals.requests), delta: 9.1, data: seriesMap.requests, color: "#38bdf8", type: "spark" },
    { label: "Cache hit rate", val: "76%", delta: 5.3, data: seriesMap.tokens.map(d => ({ ...d, value: d.value * (0.6 + Math.random() * 0.3) })), color: "#34d399", type: "bars" },
  ];
  return (
    <div>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 16 }}><RangePills value={range} onChange={setRange} /></div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 18 }}>
        {kpis.map((k, i) => (
          <GlassCard key={i} style={{ padding: 18 }}>
            <div className="card-head" style={{ marginBottom: 10 }}>
              <div className="card-title" style={{ fontSize: 12.5 }}>{k.label}</div>
              <Delta value={k.delta} />
            </div>
            <div className="stat-value" style={{ fontSize: 25 }}>{k.val}</div>
            <div style={{ marginTop: 12 }}>
              {k.type === "spark" ? <Sparkline data={k.data} width={220} height={40} color={k.color} /> : <MiniBars data={k.data} width={220} height={40} color={k.color} />}
            </div>
          </GlassCard>
        ))}
      </div>

      <GlassCard style={{ marginBottom: 18 }}>
        <div className="card-head">
          <div className="card-title"><Icon name={M.icon} />{M.label} over time</div>
          <Segmented options={METRICS.map(m => ({ value: m.key, label: m.label }))} value={metric} onChange={setMetric} />
        </div>
        <AreaChart data={seriesMap[metric]} height={280} fmt={M.fmt} color={M.color} gradId="gridArea" />
      </GlassCard>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <GlassCard>
          <div className="card-title" style={{ marginBottom: 18 }}><Icon name="cube" />Spend by model</div>
          <Donut data={D.modelSplit} valueKey="tokens" centerLabel="tokens" />
        </GlassCard>
        <GlassCard>
          <div className="card-title" style={{ marginBottom: 18 }}><Icon name="users" />Top users by spend</div>
          <div className="barlist">
            {topUsers.map((u, i) => (
              <div key={i} className="barlist-row">
                <div className="barlist-label"><Avatar {...u} size={22} /><span>{u.name}</span></div>
                <div className="barlist-val">{fmtUSD(u.spend, 0)}</div>
                <div className="barlist-track"><i style={{ width: (u.spend / maxUser) * 100 + "%" }} /></div>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

/* ---------- Variation C: Focus (one big metric) ---------- */
function UsageFocus({ range, setRange, metric, setMetric, seriesMap, totals, M }) {
  const deltas = { spend: 12.6, tokens: 18.4, requests: 9.1 };
  return (
    <div>
      <GlassCard style={{ marginBottom: 18, padding: 28 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 14 }}>
          <div>
            <div className="row gap-8" style={{ marginBottom: 8 }}>
              <Segmented accent options={METRICS.map(m => ({ value: m.key, label: m.label }))} value={metric} onChange={setMetric} />
            </div>
            <div className="stat-value big" style={{ marginTop: 14 }}>{M.fmt(totals[metric])}</div>
            <div className="row gap-8" style={{ marginTop: 8 }}>
              <Delta value={deltas[metric]} />
              <span className="faint" style={{ fontSize: 12.5 }}>vs previous period · {range}</span>
            </div>
          </div>
          <RangePills value={range} onChange={setRange} />
        </div>
        <div style={{ marginTop: 20 }}>
          <AreaChart data={seriesMap[metric]} height={300} fmt={M.fmt} color={M.color} stroke={2.8} gradId="focusArea" />
        </div>
      </GlassCard>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1.4fr" }}>
        <GlassCard>
          <div className="card-title" style={{ marginBottom: 18 }}><Icon name="cube" />Distribution by model</div>
          <Donut data={D.modelSplit} valueKey={metric === "requests" ? "requests" : "tokens"} centerLabel={metric === "requests" ? "requests" : "tokens"} fmt={fmtNum} size={170} />
        </GlassCard>
        <GlassCard className="table-wrap" style={{ padding: 0, overflow: "hidden" }}>
          <table className="tbl">
            <thead><tr><th>Model</th><th>Tokens</th><th>Requests</th><th>Spend</th><th>Share</th></tr></thead>
            <tbody>
              {D.modelSplit.map((m, i) => (
                <tr key={i}>
                  <td><span className="row gap-8"><span style={{ width: 9, height: 9, borderRadius: 3, background: m.color }} /><span className="mono">{m.label}</span></span></td>
                  <td className="mono muted">{fmtNum(m.tokens)}</td>
                  <td className="mono muted">{fmtInt(m.requests)}</td>
                  <td className="mono">{fmtUSD((m.tokens / 1e6) * m.inPrice * 1.3, 0)}</td>
                  <td><span className="badge badge-accent">{((m.tokens / D.totalTokens) * 100).toFixed(0)}%</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlassCard>
      </div>
    </div>
  );
}

Object.assign(window, { OverviewPage, UsagePage });
