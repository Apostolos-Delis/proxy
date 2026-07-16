import { Link, Outlet, useLocation, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Boxes, CircleDollarSign, Command, CreditCard, Gauge, KeyRound, Layers, Logs, Moon, PanelLeft, PanelLeftClose, Search, Settings, Sun, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { canAccessPath, isAdminRole } from "./access";
import { LogoutButton } from "./auth";
import { OrgSwitcher } from "./orgSwitcher";
import { SearchPalette } from "./search/SearchPalette";
import { useSearchShortcut } from "./search/useSearchShortcut";
import { fetchMe } from "./session";
import { ProxyLogo } from "./ui";
import { WorkspaceSwitcher } from "./workspaceSwitcher";

type NavPath =
  | "/"
  | "/usage"
  | "/cost"
  | "/caching"
  | "/logs"
  | "/settings"
  | "/models"
  | "/api-keys"
  | "/users"
  | "/billing";

type NavItem = { to: NavPath; label: string; icon: LucideIcon };

const workspaceNav = [
  { to: "/", label: "Overview", icon: Gauge },
  { to: "/usage", label: "Usage", icon: BarChart3 },
  { to: "/cost", label: "Cost", icon: CircleDollarSign },
  { to: "/caching", label: "Caching", icon: Layers },
  { to: "/logs", label: "Logs", icon: Logs }
] as const;

const operationsNav = [
  { to: "/settings", label: "Settings", icon: Settings }
] as const;

const manageNav = [
  { to: "/models", label: "Models", icon: Boxes },
  { to: "/api-keys", label: "API keys", icon: KeyRound },
  { to: "/users", label: "Users", icon: Users },
  { to: "/billing", label: "Billing", icon: CreditCard }
] as const;

const titles: Record<string, [string, string | null]> = {
  "/": ["Overview", null],
  "/usage": ["Usage", "Token metering by dimension"],
  "/cost": ["Cost", "Spend, savings & attribution"],
  "/caching": ["Caching", "Prompt-cache performance"],
  "/models": ["Models", "Logical models & endpoints"],
  "/api-keys": ["API keys", "Manage secrets"],
  "/api-keys/new": ["API keys", "Create key"],
  "/users": ["Users", "Team & access"],
  "/billing": ["Billing", "Spend & pricing"],
  "/settings": ["Settings", "Runtime configuration"],
  "/prompts": ["Prompts", "Captured prompt artifacts"]
};

export function AppShell() {
  const location = useLocation();
  const search = useSearch({ strict: false }) as { view?: unknown };
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [searchOpen, setSearchOpen] = useState(false);
  useSearchShortcut(() => setSearchOpen((value) => !value));
  const publicRoute = location.pathname === "/login" || location.pathname.startsWith("/invite/");
  const { data: meQueryData } = useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    enabled: !publicRoute
  });
  const isAdmin = isAdminRole(meQueryData?.user.role);

  if (publicRoute) {
    return (
      <main className="login-shell">
        <Outlet />
      </main>
    );
  }

  const [title, subtitle] = titleForPath(location.pathname, search);
  return (
    <div className={`app${collapsed ? " collapsed" : ""}`} data-theme={theme}>
      <aside className="sidebar">
        <Brand collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)} />
        <WorkspaceSwitcher />
        <NavGroup title="Workspace" items={visibleNavItems(workspaceNav, isAdmin)} collapsed={collapsed} activePathname={location.pathname} />
        <NavGroup title="Operations" items={visibleNavItems(operationsNav, isAdmin)} collapsed={collapsed} activePathname={location.pathname} />
        <NavGroup title="Manage" items={visibleNavItems(manageNav, isAdmin)} collapsed={collapsed} activePathname={location.pathname} />
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
          {isAdmin ? <Link to="/settings" className="btn btn-ghost btn-icon" aria-label="Settings">
            <Settings />
          </Link> : null}
          <div className="avatar operator">AD</div>
        </header>
        <div className="scroll">
          <Outlet />
        </div>
      </main>
      {searchOpen ? <SearchPalette isAdmin={isAdmin} onClose={() => setSearchOpen(false)} /> : null}
    </div>
  );
}

function Brand({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const toggle = (
    <button
      className="sidebar-toggle"
      type="button"
      aria-label={collapsed ? "Open sidebar" : "Close sidebar"}
      aria-expanded={!collapsed}
      title={collapsed ? "Open sidebar" : undefined}
      onClick={onToggle}
    >
      {collapsed ? <PanelLeft /> : <PanelLeftClose />}
    </button>
  );

  return (
    <div className="brand">
      {collapsed ? (
        <div className="collapsed-brand-control">
          <div className="brand-mark"><ProxyLogo size={20} /></div>
          {toggle}
        </div>
      ) : (
        <>
          <div className="brand-lockup">
            <div className="brand-mark"><ProxyLogo size={20} /></div>
            <div className="brand-text">
              <div className="brand-name">proxy</div>
              <div className="brand-sub">platform console</div>
            </div>
          </div>
          {toggle}
        </>
      )}
    </div>
  );
}

function NavGroup({ title, items, collapsed, activePathname }: { title: string; items: readonly NavItem[]; collapsed: boolean; activePathname: string }) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="nav-group-label brand-text">{title}</div>
      <nav className="nav-group" aria-label={title} data-collapsed={collapsed ? "true" : "false"}>
        {items.map((item) => {
          const Icon = item.icon;
          const active = navItemActive(item.to, activePathname);
          return (
            <Link key={item.to} to={item.to} className={`nav-item${active ? " active" : ""}`} title={collapsed ? item.label : undefined}>
              <Icon />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function visibleNavItems(items: readonly NavItem[], isAdmin: boolean) {
  return items.filter((item) => canAccessPath(item.to, isAdmin));
}

function navItemActive(path: NavPath, pathname: string) {
  if (path === "/") return pathname === "/";
  if (path === "/logs" && pathname.startsWith("/sessions/")) return true;
  return pathname === path || pathname.startsWith(`${path}/`);
}

function titleForPath(pathname: string, search: { view?: unknown }) {
  if (pathname === "/logs") return ["Logs", search.view === "requests" ? "Request stream" : "Agent session replay"] as const;
  const direct = titles[pathname];
  if (direct) return direct;
  if (pathname.startsWith("/logs/")) return ["Logs", "Prompt detail"] as const;
  if (pathname.startsWith("/prompts/")) return ["Prompts", "Prompt detail"] as const;
  if (pathname.startsWith("/sessions/")) return ["Logs", "Session replay"] as const;
  return ["Proxy", "LLM cost console"] as const;
}
