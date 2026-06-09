/* Proxy — app shell, routing, theme */

const TITLES = {
  overview: ["Overview", null],
  usage: ["Usage", "Token metering & spend"],
  logs: ["Logs", "Request stream"],
  keys: ["API keys", "Manage secrets"],
  users: ["Users", "Team & access"],
  billing: ["Billing", "Spend & invoices"],
};

function App() {
  const [page, setPage] = useState("usage");
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("proxy-theme") || "dark");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("proxy-theme", theme);
  }, [theme]);

  const [t, sub] = TITLES[page];

  return (
    <div className={"app" + (collapsed ? " collapsed" : "")}>
      <Sidebar page={page} setPage={setPage} collapsed={collapsed} theme={theme} />
      <div className="main">
        <Topbar title={t} crumb={sub} theme={theme}
          toggleTheme={() => setTheme(x => x === "dark" ? "light" : "dark")}
          toggleCollapse={() => setCollapsed(c => !c)}>
          <div className="input" style={{ minWidth: 200 }}>
            <Icon name="search" size={15} />
            <input placeholder="Search…" />
            <span className="kbd">⌘K</span>
          </div>
        </Topbar>
        <div className="scroll" key={page}>
          {page === "overview" && <OverviewPage />}
          {page === "usage" && <UsagePage />}
          {page === "logs" && <LogsPage />}
          {page === "keys" && <KeysPage />}
          {page === "users" && <UsersPage />}
          {page === "billing" && <BillingPage />}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
