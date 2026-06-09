/* Proxy — shared UI: icons, sidebar, topbar, primitives */

/* ============================================================
   ICONS — stroke 1.6, rounded caps (Lucide-ish)
   ============================================================ */
const ICONS = {
  home: "M3 10.5 12 3l9 7.5M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5",
  usage: "M3 3v18h18M8 17V9m5 8V5m5 12v-6",
  key: "M15.5 7.5a3.5 3.5 0 1 1-4.95 3.16L3 18.7V21h2.3l.7-.7v-1.6h1.6l.7-.7v-1.6h1.6l1.34-1.34A3.5 3.5 0 0 1 15.5 7.5Zm1.5 1.2h.01",
  users: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5ZM20 20v-1.5a3.5 3.5 0 0 0-2.6-3.38M15 5.1a3.25 3.25 0 0 1 0 6.3",
  logs: "M4 5h16M4 5v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V5M4 5 5 3h14l1 2M8 10h8M8 14h5",
  billing: "M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5v-9ZM3 10h18M7 14h3",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  filter: "M3 5h18l-7 8v6l-4-2v-4L3 5Z",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 6 6 6-6 6",
  chevronUpDown: "m8 9 4-4 4 4M8 15l4 4 4-4",
  copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM4 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v0",
  trash: "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7M10 11v6M14 11v6",
  edit: "M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17.2V20zM14 7l3 3",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  panel: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM9 4v16",
  external: "M14 4h6v6M20 4l-8 8M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 13a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-2.55 1.06V18.5a1.8 1.8 0 1 1-3.6 0v-.1A1.5 1.5 0 0 0 7 17.05l-.05.05a1.8 1.8 0 1 1-2.55-2.55l.05-.05A1.5 1.5 0 0 0 5.5 12a1.8 1.8 0 0 1 0-3.6h.1A1.5 1.5 0 0 0 7 5.8l-.05-.05A1.8 1.8 0 1 1 9.5 3.2l.05.05A1.5 1.5 0 0 0 12 2.7a1.8 1.8 0 0 1 3.6 0v.1A1.5 1.5 0 0 0 18 4.95",
  sparkles: "M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3ZM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z",
  x: "M6 6l12 12M18 6 6 18",
  arrowUpRight: "M7 17 17 7M7 7h10v10",
  arrowDown: "M12 5v14M19 12l-7 7-7-7",
  arrowUp: "M12 19V5M5 12l7-7 7 7",
  check: "M5 12.5 10 17.5 19.5 7",
  zap: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
  cube: "M12 2 3 7v10l9 5 9-5V7l-9-5ZM3 7l9 5 9-5M12 12v10",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  dollar: "M12 2v20M16.5 6.5C16.5 5 14.5 4 12 4S7.5 5 7.5 7s2 2.6 4.5 3 4.5 1.4 4.5 3.5-2 3-4.5 3-4.5-1-4.5-2.5",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
  alert: "M12 8v5m0 3.5h.01M10.3 3.3 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0Z",
  refresh: "M3 12a9 9 0 0 1 15-6.7L21 8M21 4v4h-4M21 12a9 9 0 0 1-15 6.7L3 16M3 20v-4h4",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M5 19h14",
  calendar: "M7 3v3m10-3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z",
  shield: "M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6l-8-3Z",
};

function Icon({ name, size = 18, style, className, strokeWidth = 1.6 }) {
  const d = ICONS[name] || "";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      style={style} className={className}>
      {d.split(" M").map((seg, i) => <path key={i} d={(i === 0 ? "" : "M") + seg} />)}
    </svg>
  );
}

/* ============================================================
   SIDEBAR
   ============================================================ */
const NAV = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "usage",    label: "Usage",    icon: "usage" },
  { id: "logs",     label: "Logs",     icon: "logs" },
  { id: "keys",     label: "API keys", icon: "key" },
  { id: "users",    label: "Users",    icon: "users" },
  { id: "billing",  label: "Billing",  icon: "billing" },
];

function Sidebar({ page, setPage, collapsed, theme }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" /><path d="m3 7 9 5 9-5M12 12v10" />
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-name">proxy</div>
          <div className="brand-sub">platform console</div>
        </div>
      </div>

      <div className="nav-group-label brand-text">Workspace</div>
      {NAV.slice(0, 3).map(n => (
        <div key={n.id} className={"nav-item" + (page === n.id ? " active" : "")} onClick={() => setPage(n.id)} title={n.label}>
          <Icon name={n.icon} /><span>{n.label}</span>
        </div>
      ))}
      <div className="nav-group-label brand-text">Manage</div>
      {NAV.slice(3).map(n => (
        <div key={n.id} className={"nav-item" + (page === n.id ? " active" : "")} onClick={() => setPage(n.id)} title={n.label}>
          <Icon name={n.icon} /><span>{n.label}</span>
        </div>
      ))}

      <div className="sidebar-foot">
        <div className="org-card">
          <div className="org-avatar">P</div>
          <div className="brand-text" style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Proxy Labs</div>
            <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>Team · Mid</div>
          </div>
          <Icon name="chevronUpDown" size={15} style={{ marginLeft: "auto", color: "var(--fg-faint)" }} />
        </div>
      </div>
    </aside>
  );
}

/* ============================================================
   TOPBAR
   ============================================================ */
function Topbar({ title, crumb, theme, toggleTheme, toggleCollapse, children }) {
  return (
    <div className="topbar">
      <button className="btn btn-ghost btn-icon" onClick={toggleCollapse} title="Toggle sidebar">
        <Icon name="panel" size={18} />
      </button>
      <div>
        <h1>{title}</h1>
        {crumb && <div className="crumb">{crumb}</div>}
      </div>
      <div className="topbar-spacer" />
      {children}
      <button className="btn btn-ghost btn-icon" onClick={toggleTheme} title="Toggle theme">
        <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
      </button>
      <div className="avatar" style={{ background: "var(--accent)", color: "#04211d" }}>AD</div>
    </div>
  );
}

/* ============================================================
   PRIMITIVES
   ============================================================ */
function GlassCard({ children, className = "", style, ...rest }) {
  return <div className={"glass card " + className} style={style} {...rest}>{children}</div>;
}

function Badge({ children, variant, dot }) {
  return <span className={"badge" + (variant ? " badge-" + variant : "")}>{dot && <span className="dot" />}{children}</span>;
}

function StatusBadge({ status }) {
  if (status === "active" || status === "success") return <Badge variant="success" dot>{status === "success" ? "Success" : "Active"}</Badge>;
  if (status === "error") return <Badge variant="danger" dot>Error</Badge>;
  if (status === "inactive") return <span className="badge" style={{ color: "var(--fg-faint)" }}><span className="dot" />Inactive</span>;
  if (status === "invited") return <Badge variant="warn" dot>Invited</Badge>;
  return <Badge dot>{status}</Badge>;
}

function Avatar({ name, color, initials, size = 30 }) {
  return <div className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.4 }}>{initials || (name ? name.split(" ").map(w => w[0]).slice(0, 2).join("") : "?")}</div>;
}

function Segmented({ options, value, onChange, accent }) {
  return (
    <div className={"segmented" + (accent ? " accent" : "")}>
      {options.map(o => (
        <button key={o.value} className={value === o.value ? "active" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

function Delta({ value, suffix = "%" }) {
  const up = value >= 0;
  return <span className={"delta " + (up ? "up" : "down")}><Icon name={up ? "arrowUp" : "arrowDown"} size={12} />{Math.abs(value)}{suffix}</span>;
}

/* copy-to-clipboard pill */
function CopyField({ text, display }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="code-pill" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
      onClick={() => { navigator.clipboard && navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      title="Copy">
      {display || text}
      <Icon name={copied ? "check" : "copy"} size={12} style={{ color: copied ? "var(--success)" : "var(--fg-faint)" }} />
    </span>
  );
}

/* time-range pills shared control */
function RangePills({ value, onChange }) {
  const ranges = [{ value: "24h", label: "24h" }, { value: "7d", label: "7d" }, { value: "30d", label: "30d" }, { value: "90d", label: "90d" }];
  return <Segmented options={ranges} value={value} onChange={onChange} />;
}

Object.assign(window, {
  Icon, ICONS, NAV, Sidebar, Topbar, GlassCard, Badge, StatusBadge, Avatar, Segmented, Delta, CopyField, RangePills,
});
