/* Proxy — Logs, API keys, Users, Billing */

const DM = window.PROXY_DATA;

/* ============================================================
   LOGS — prompts feed, filter by user/model/status, detail drawer
   ============================================================ */
function LogsPage() {
  const [q, setQ] = useState("");
  const [userFilter, setUserFilter] = useState("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selected, setSelected] = useState(null);
  const [showUserMenu, setShowUserMenu] = useState(false);

  const filtered = DM.LOGS.filter(l => {
    if (userFilter !== "all" && l.userId !== userFilter) return false;
    if (modelFilter !== "all" && l.model !== modelFilter) return false;
    if (statusFilter !== "all" && l.status !== statusFilter) return false;
    if (q && !(l.prompt.toLowerCase().includes(q.toLowerCase()) || l.user.toLowerCase().includes(q.toLowerCase()) || l.id.includes(q))) return false;
    return true;
  });

  const activeUser = DM.USERS.find(u => u.id === userFilter);

  return (
    <div className="page page-enter">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.03em" }}>Request logs</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>Every prompt routed through Proxy, in real time.</div>
        </div>
        <button className="btn"><Icon name="download" size={15} />Export</button>
      </div>

      {/* filter bar */}
      <div className="row gap-8" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        <div className="input" style={{ flex: 1, minWidth: 240 }}>
          <Icon name="search" />
          <input placeholder="Search prompts, users, request IDs…" value={q} onChange={e => setQ(e.target.value)} />
        </div>

        <div style={{ position: "relative" }}>
          <div className={"chip" + (userFilter !== "all" ? " active" : "")} onClick={() => setShowUserMenu(s => !s)}>
            <Icon name="users" size={14} />
            {activeUser ? activeUser.name : "All users"}
            <Icon name="chevronDown" size={13} />
          </div>
          {showUserMenu && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 20 }} onClick={() => setShowUserMenu(false)} />
              <div className="glass" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 21, width: 248, maxHeight: 320, overflowY: "auto", padding: 6, borderRadius: 10 }}>
                <div className={"nav-item" + (userFilter === "all" ? " active" : "")} onClick={() => { setUserFilter("all"); setShowUserMenu(false); }} style={{ fontSize: 13 }}>
                  <Icon name="users" size={15} /><span>All users</span>
                </div>
                {DM.USERS.filter(u => u.tokens > 0).map(u => (
                  <div key={u.id} className={"nav-item" + (userFilter === u.id ? " active" : "")} onClick={() => { setUserFilter(u.id); setShowUserMenu(false); }} style={{ fontSize: 13 }}>
                    <Avatar {...u} size={20} /><span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <FilterSelect icon="cube" label="model" value={modelFilter} onChange={setModelFilter}
          options={[{ value: "all", label: "All models" }, ...DM.MODELS.map(m => ({ value: m.id, label: m.label }))]} />
        <FilterSelect icon="shield" label="status" value={statusFilter} onChange={setStatusFilter}
          options={[{ value: "all", label: "All statuses" }, { value: "success", label: "Success" }, { value: "error", label: "Error" }]} />

        <span className="faint" style={{ fontSize: 12.5, alignSelf: "center", marginLeft: "auto" }}>{filtered.length} requests</span>
      </div>

      <GlassCard className="table-wrap" style={{ padding: 0 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Prompt</th><th>User</th><th>Model</th><th>Tokens</th><th>Cost</th><th>Latency</th><th>Status</th><th>Time</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(l => (
              <tr key={l.id} onClick={() => setSelected(l)} style={{ cursor: "pointer" }}>
                <td style={{ maxWidth: 300 }}>
                  <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 300 }}>{l.prompt}</div>
                  <div className="mono faint" style={{ fontSize: 11, marginTop: 2 }}>{l.id}</div>
                </td>
                <td><div className="user-cell"><Avatar color={l.userColor} initials={l.userInitials} size={24} /><span style={{ fontSize: 12.5 }}>{l.user.split(" ")[0]}</span></div></td>
                <td><span className="row gap-8"><span style={{ width: 8, height: 8, borderRadius: 2, background: l.modelColor }} /><span className="mono" style={{ fontSize: 12 }}>{l.model}</span></span></td>
                <td className="mono muted">{fmtInt(l.totalTok)}</td>
                <td className="mono">{fmtUSD(l.cost, 4)}</td>
                <td className="mono muted">{l.latency}ms</td>
                <td><StatusBadge status={l.status} /></td>
                <td className="faint" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{l.tsLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty">No requests match these filters.</div>}
      </GlassCard>

      {selected && <LogDrawer log={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function FilterSelect({ icon, value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const current = options.find(o => o.value === value);
  return (
    <div style={{ position: "relative" }}>
      <div className={"chip" + (value !== "all" ? " active" : "")} onClick={() => setOpen(s => !s)}>
        <Icon name={icon} size={14} />{current.label}<Icon name="chevronDown" size={13} />
      </div>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 20 }} onClick={() => setOpen(false)} />
          <div className="glass" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 21, width: 210, padding: 6, borderRadius: 10 }}>
            {options.map(o => (
              <div key={o.value} className={"nav-item" + (value === o.value ? " active" : "")} onClick={() => { onChange(o.value); setOpen(false); }} style={{ fontSize: 13 }}>
                <span>{o.label}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function LogDrawer({ log, onClose }) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
          <div className="row gap-8"><StatusBadge status={log.status} /><span className="mono faint" style={{ fontSize: 12 }}>{log.id}</span></div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 22 }}>
          {[["Model", log.model], ["User", log.user], ["API key", log.keyName], ["Latency", log.latency + " ms"], ["Temperature", log.temperature], ["Time", log.tsLabel]].map((r, i) => (
            <div key={i}>
              <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3 }}>{r[0]}</div>
              <div className="mono" style={{ fontSize: 13 }}>{r[1]}</div>
            </div>
          ))}
        </div>

        <div className="glass-2" style={{ padding: 14, marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <div className="row gap-16">
              <div><div className="faint" style={{ fontSize: 11 }}>Input</div><div className="mono" style={{ fontWeight: 600 }}>{fmtInt(log.inTok)}</div></div>
              <div><div className="faint" style={{ fontSize: 11 }}>Output</div><div className="mono" style={{ fontWeight: 600 }}>{fmtInt(log.outTok)}</div></div>
              <div><div className="faint" style={{ fontSize: 11 }}>Total</div><div className="mono" style={{ fontWeight: 600 }}>{fmtInt(log.totalTok)}</div></div>
            </div>
            <div style={{ textAlign: "right" }}><div className="faint" style={{ fontSize: 11 }}>Cost</div><div className="mono" style={{ fontWeight: 600, color: "var(--accent-2)" }}>{fmtUSD(log.cost, 4)}</div></div>
          </div>
        </div>

        <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Prompt</div>
        <div className="glass-2" style={{ padding: 14, marginBottom: 18, fontSize: 13, lineHeight: 1.6 }}>{log.prompt}</div>

        <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Response</div>
        {log.status === "error" ? (
          <div className="glass-2" style={{ padding: 14, fontSize: 13, lineHeight: 1.6, color: "var(--danger)", borderColor: "var(--danger)" }}>
            <Icon name="alert" size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />{log.errorMsg}
          </div>
        ) : (
          <div className="glass-2 mono" style={{ padding: 14, fontSize: 12.5, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{log.response}</div>
        )}
      </div>
    </>
  );
}

/* ============================================================
   API KEYS
   ============================================================ */
function KeysPage() {
  const [q, setQ] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const [keys, setKeys] = useState(DM.KEYS);
  const [creating, setCreating] = useState(false);

  const filtered = keys.filter(k => {
    if (onlyActive && k.status !== "active") return false;
    if (q && !k.name.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  function createKey(name) {
    const u = DM.USERS[0];
    const k = {
      id: "key_" + Math.random().toString(36).slice(2, 10),
      name: name || "new-key", perms: "All", status: "active",
      tracking: "key_" + Math.random().toString(36).slice(2, 14),
      secret: "sk-proxy-" + Math.random().toString(36).slice(2, 6) + "..." + Math.random().toString(36).slice(2, 6).toUpperCase(),
      created: "Jun 8, 2026", lastUsed: "Never", creator: u.name, creatorColor: u.color, creatorInitials: u.initials,
      spend: 0, requests: 0,
    };
    setKeys([k, ...keys]);
    setCreating(false);
  }

  return (
    <div className="page page-enter">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.03em" }}>API keys</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>Keys carry the permissions of their owner. Keep them secret.</div>
        </div>
        <div className="row gap-8">
          <button className="btn"><Icon name="usage" size={15} />Key usage<Icon name="external" size={13} /></button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} />Create new key</button>
        </div>
      </div>

      <div className="row gap-8" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        <div className="input" style={{ flex: 1, minWidth: 240 }}>
          <Icon name="search" /><input placeholder="Search keys…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className={"chip" + (onlyActive ? " active" : "")} onClick={() => setOnlyActive(a => !a)}>
          <Icon name={onlyActive ? "check" : "filter"} size={14} />Active only
        </div>
        <span className="faint" style={{ fontSize: 12.5, alignSelf: "center" }}>{filtered.length} keys</span>
      </div>

      <GlassCard className="table-wrap" style={{ padding: 0 }}>
        <table className="tbl">
          <thead><tr><th>Name</th><th>Status</th><th>Secret key</th><th>Spend</th><th>Created</th><th>Last used</th><th>Owner</th><th></th></tr></thead>
          <tbody>
            {filtered.map(k => (
              <tr key={k.id}>
                <td><div style={{ fontWeight: 500 }}>{k.name}</div><div className="mono faint" style={{ fontSize: 11 }}>{k.tracking.slice(0, 18)}…</div></td>
                <td><StatusBadge status={k.status} /></td>
                <td><CopyField text={k.secret} /></td>
                <td className="mono">{fmtUSD(k.spend, 0)}</td>
                <td className="faint" style={{ fontSize: 12.5 }}>{k.created}</td>
                <td className="faint" style={{ fontSize: 12.5 }}>{k.lastUsed}</td>
                <td><div className="user-cell"><Avatar color={k.creatorColor} initials={k.creatorInitials} size={24} /><span style={{ fontSize: 12.5 }}>{k.creator.split(" ")[0]}</span></div></td>
                <td>
                  <div className="row-actions">
                    <button className="btn btn-ghost btn-icon"><Icon name="edit" size={15} /></button>
                    <button className="btn btn-ghost btn-icon" onClick={() => setKeys(keys.filter(x => x.id !== k.id))}><Icon name="trash" size={15} style={{ color: "var(--danger)" }} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty">No keys match. Create one to get started.</div>}
      </GlassCard>

      {creating && <CreateKeyModal onClose={() => setCreating(false)} onCreate={createKey} />}
    </div>
  );
}

function CreateKeyModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [perm, setPerm] = useState("All");
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="glass" style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 41, width: 440, padding: 26, borderRadius: 12 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Create secret key</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        <label className="faint" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>Name</label>
        <div className="input" style={{ width: "100%", marginBottom: 16 }}>
          <input placeholder="e.g. production-web" value={name} onChange={e => setName(e.target.value)} autoFocus />
        </div>
        <label className="faint" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>Permissions</label>
        <div style={{ marginBottom: 24 }}>
          <Segmented options={[{ value: "All", label: "All" }, { value: "Write", label: "Write" }, { value: "Read", label: "Read" }]} value={perm} onChange={setPerm} />
        </div>
        <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onCreate(name)}><Icon name="key" size={15} />Create key</button>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   USERS
   ============================================================ */
function UsersPage() {
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const roles = ["all", ...Array.from(new Set(DM.USERS.map(u => u.role)))];
  const filtered = DM.USERS.filter(u => {
    if (roleFilter !== "all" && u.role !== roleFilter) return false;
    if (q && !(u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))) return false;
    return true;
  });
  const active = DM.USERS.filter(u => u.status === "active").length;

  return (
    <div className="page page-enter">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.03em" }}>Users</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>{DM.USERS.length} members · {active} active</div>
        </div>
        <button className="btn btn-primary"><Icon name="plus" size={15} />Invite member</button>
      </div>

      <div className="row gap-8" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        <div className="input" style={{ flex: 1, minWidth: 240 }}>
          <Icon name="search" /><input placeholder="Search members…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="row gap-8" style={{ flexWrap: "wrap" }}>
          {roles.map(r => (
            <div key={r} className={"chip" + (roleFilter === r ? " active" : "")} onClick={() => setRoleFilter(r)}>{r === "all" ? "All roles" : r}</div>
          ))}
        </div>
      </div>

      <GlassCard className="table-wrap" style={{ padding: 0 }}>
        <table className="tbl">
          <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>API keys</th><th>Tokens (30d)</th><th>Spend (30d)</th><th>Joined</th></tr></thead>
          <tbody>
            {filtered.map(u => (
              <tr key={u.id}>
                <td><div className="user-cell"><Avatar {...u} size={32} /><div><div className="user-name">{u.name}</div><div className="user-email">{u.email}</div></div></div></td>
                <td><Badge variant={u.role === "Owner" ? "accent" : undefined}>{u.role}</Badge></td>
                <td><StatusBadge status={u.status} /></td>
                <td className="mono muted">{u.keys}</td>
                <td className="mono muted">{u.tokens ? fmtNum(u.tokens) : "—"}</td>
                <td className="mono">{u.spend ? fmtUSD(u.spend, 0) : "—"}</td>
                <td className="faint" style={{ fontSize: 12.5 }}>{u.joined}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty">No members match your search.</div>}
      </GlassCard>
    </div>
  );
}

/* ============================================================
   BILLING
   ============================================================ */
function BillingPage() {
  const monthSpend = sumOf(DM.spendSeries);
  const budgetPct = Math.min(100, (monthSpend / DM.monthBudget) * 100);
  const [softAlert, setSoftAlert] = useState(true);
  const invoices = [
    ["May 2026", 7240.18, "paid"], ["Apr 2026", 6105.55, "paid"], ["Mar 2026", 5012.30, "paid"], ["Feb 2026", 3890.74, "paid"], ["Jan 2026", 2140.09, "paid"],
  ];
  const projected = monthSpend * (30 / 8);

  return (
    <div className="page page-enter">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.03em" }}>Billing</h2>
          <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>Spend, budgets, and invoices for Proxy Labs.</div>
        </div>
        <div className="row gap-8">
          <button className="btn"><Icon name="billing" size={15} />Payment method</button>
          <button className="btn btn-primary"><Icon name="plus" size={15} />Add credits</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.4fr 1fr 1fr", marginBottom: 18 }}>
        <GlassCard>
          <div className="card-title">Current spend · June</div>
          <div className="stat-value" style={{ marginTop: 8 }}>{fmtUSD(monthSpend)}</div>
          <div className="meter" style={{ marginTop: 14 }}><i style={{ width: budgetPct + "%" }} /></div>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
            <span className="faint" style={{ fontSize: 12 }}>{budgetPct.toFixed(0)}% of {fmtUSD(DM.monthBudget, 0)} budget</span>
            <span className="badge badge-accent">{fmtUSD(DM.monthBudget - monthSpend, 0)} left</span>
          </div>
        </GlassCard>
        <GlassCard>
          <div className="card-title"><Icon name="clock" />Projected</div>
          <div className="stat-value" style={{ marginTop: 8, fontSize: 26 }}>{fmtUSD(projected, 0)}</div>
          <div className="stat-sub">end of month at current rate</div>
        </GlassCard>
        <GlassCard>
          <div className="card-title"><Icon name="billing" />Credit balance</div>
          <div className="stat-value" style={{ marginTop: 8, fontSize: 26 }}>{fmtUSD(12500 - monthSpend, 0)}</div>
          <div className="stat-sub">auto-reload at $1,000</div>
        </GlassCard>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <GlassCard>
          <div className="card-title" style={{ marginBottom: 16 }}><Icon name="alert" />Spend alerts</div>
          {[["Soft limit", "$6,000", "Email the team when reached", softAlert, setSoftAlert], ["Hard limit", "$8,000", "Pause all requests when reached", true, null]].map((a, i) => (
            <div key={i} className="row" style={{ justifyContent: "space-between", padding: "13px 0", borderBottom: i === 0 ? "1px solid var(--border)" : "none" }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: 13.5 }}>{a[0]} · <span className="mono">{a[1]}</span></div>
                <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{a[2]}</div>
              </div>
              <Toggle on={a[3]} onClick={a[4] ? () => a[4](v => !v) : undefined} />
            </div>
          ))}
          <div className="sep" />
          <div className="card-title" style={{ marginBottom: 12 }}><Icon name="key" />Per-key limits</div>
          <div className="barlist">
            {[...DM.KEYS].sort((a, b) => b.spend - a.spend).slice(0, 4).map((k, i) => (
              <div key={i} className="barlist-row">
                <div className="barlist-label"><Icon name="key" size={13} style={{ color: "var(--fg-faint)" }} /><span className="mono">{k.name}</span></div>
                <div className="barlist-val">{fmtUSD(k.spend, 0)} / $2k</div>
                <div className="barlist-track"><i style={{ width: Math.min(100, (k.spend / 2000) * 100) + "%", background: k.spend > 1600 ? "var(--danger)" : undefined }} /></div>
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard className="table-wrap" style={{ padding: 0 }}>
          <div className="card" style={{ paddingBottom: 4 }}><div className="card-title"><Icon name="billing" />Invoices</div></div>
          <table className="tbl">
            <thead><tr><th>Period</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {invoices.map((inv, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 500 }}>{inv[0]}</td>
                  <td className="mono">{fmtUSD(inv[1])}</td>
                  <td><StatusBadge status={inv[2] === "paid" ? "success" : "error"} /></td>
                  <td><div className="row-actions"><button className="btn btn-ghost btn-sm"><Icon name="download" size={14} />PDF</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlassCard>
      </div>
    </div>
  );
}

function Toggle({ on, onClick }) {
  return (
    <div onClick={onClick} style={{
      width: 40, height: 23, borderRadius: 999, padding: 2, cursor: onClick ? "pointer" : "default",
      background: on ? "var(--accent)" : "var(--track)",
      transition: "background .2s var(--ease)", flex: "none", opacity: onClick ? 1 : 0.6,
    }}>
      <div style={{ width: 19, height: 19, borderRadius: "50%", background: "#fff", transform: on ? "translateX(17px)" : "none", transition: "transform .2s var(--ease)", boxShadow: "0 1px 3px rgba(0,0,0,.3)" }} />
    </div>
  );
}

Object.assign(window, { LogsPage, KeysPage, UsersPage, BillingPage });
