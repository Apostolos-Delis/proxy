import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { BarChart3, Boxes, Command, CreditCard, Gauge, GitBranch, KeyRound, Logs, MessagesSquare, Moon, PanelLeft, PanelLeftClose, Search, Settings, Sun, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { LogoutButton } from "./auth";
import { OrgSwitcher } from "./orgSwitcher";
import { SearchPalette } from "./search/SearchPalette";
import { useSearchShortcut } from "./search/useSearchShortcut";

const workspaceNav = [
  { to: "/", label: "Overview", icon: Gauge },
  { to: "/usage", label: "Usage", icon: BarChart3 },
  { to: "/logs", label: "Logs", icon: Logs },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare }
] as const;

const operationsNav = [
  { to: "/routing-configs", label: "Routing", icon: GitBranch },
  { to: "/settings", label: "Settings", icon: Settings }
] as const;

const manageNav = [
  { to: "/api-keys", label: "API keys", icon: KeyRound },
  { to: "/users", label: "Users", icon: Users },
  { to: "/billing", label: "Billing", icon: CreditCard }
] as const;

const titles: Record<string, [string, string | null]> = {
  "/": ["Overview", null],
  "/usage": ["Usage", "Token metering & spend"],
  "/logs": ["Logs", "Request stream"],
  "/api-keys": ["API keys", "Manage secrets"],
  "/users": ["Users", "Team & access"],
  "/billing": ["Billing", "Spend & invoices"],
  "/settings": ["Settings", "Runtime configuration"],
  "/routing-configs": ["Routing", "Config versions"],
  "/prompts": ["Prompts", "Captured prompt artifacts"],
  "/sessions": ["Sessions", "Agent session replay"]
};

export function AppShell() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [searchOpen, setSearchOpen] = useState(false);
  useSearchShortcut(() => setSearchOpen((value) => !value));
  if (location.pathname === "/login" || location.pathname.startsWith("/invite/")) {
    return (
      <main className="login-shell">
        <Outlet />
      </main>
    );
  }

  const [title, subtitle] = titleForPath(location.pathname);
  return (
    <div className={`app${collapsed ? " collapsed" : ""}`} data-theme={theme}>
      <aside className="sidebar">
        <Brand collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
        <NavGroup title="Workspace" items={workspaceNav} collapsed={collapsed} />
        <NavGroup title="Operations" items={operationsNav} collapsed={collapsed} />
        <NavGroup title="Manage" items={manageNav} collapsed={collapsed} />
        <div className="sidebar-foot">
          <OrgSwitcher />
          <LogoutButton />
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            {subtitle ? <div className="crumb">{subtitle}</div> : null}
          </div>
          <div className="topbar-spacer" />
          <button type="button" className="input topbar-search" onClick={() => setSearchOpen(true)}>
            <Search />
            <span className="topbar-search-label">Search...</span>
            <span className="kbd"><Command /><span>K</span></span>
          </button>
          <button
            className="btn btn-ghost btn-icon"
            type="button"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
          <Link to="/settings" className="btn btn-ghost btn-icon" aria-label="Settings">
            <Settings />
          </Link>
          <div className="avatar operator">AD</div>
        </header>
        <div className="scroll">
          <Outlet />
        </div>
      </main>
      {searchOpen ? <SearchPalette onClose={() => setSearchOpen(false)} /> : null}
    </div>
  );
}

function Brand({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <div className="brand">
      {collapsed ? null : (
        <div className="brand-lockup">
          <div className="brand-mark"><Boxes /></div>
          <div className="brand-text">
            <div className="brand-name">proxy</div>
            <div className="brand-sub">platform console</div>
          </div>
        </div>
      )}
      <button className="sidebar-toggle" type="button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={onToggle}>
        {collapsed ? <PanelLeft /> : <PanelLeftClose />}
      </button>
    </div>
  );
}

function NavGroup({ title, items, collapsed }: { title: string; items: readonly { to: string; label: string; icon: LucideIcon }[]; collapsed: boolean }) {
  return (
    <>
      <div className="nav-group-label brand-text">{title}</div>
      <nav className="nav-group" aria-label={title} data-collapsed={collapsed ? "true" : "false"}>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.to} to={item.to} className="nav-item" title={collapsed ? item.label : undefined} activeProps={{ className: "nav-item active" }}>
              <Icon />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function titleForPath(pathname: string) {
  const direct = titles[pathname];
  if (direct) return direct;
  if (pathname.startsWith("/logs/")) return ["Logs", "Prompt detail"] as const;
  if (pathname.startsWith("/prompts/")) return ["Prompts", "Prompt detail"] as const;
  if (pathname.startsWith("/sessions/")) return ["Sessions", "Session replay"] as const;
  if (pathname.startsWith("/routing-configs/")) return ["Routing", "Config detail"] as const;
  return ["Proxy", "LLM cost console"] as const;
}
