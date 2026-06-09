import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { BarChart3, FileText, Gauge, GitBranch, ListFilter, Settings as SettingsIcon } from "lucide-react";

import { LogoutButton } from "./auth";

export function AppShell() {
  const location = useLocation();
  if (location.pathname === "/login") {
    return (
      <main className="login-shell">
        <Outlet />
      </main>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <GitBranch size={20} />
          <span>Prompt Proxy</span>
        </div>
        <nav>
          <Link to="/" activeProps={{ className: "active" }}>
            <Gauge size={18} />
            Overview
          </Link>
          <Link to="/usage" activeProps={{ className: "active" }}>
            <BarChart3 size={18} />
            Usage
          </Link>
          <Link to="/prompts" activeProps={{ className: "active" }}>
            <FileText size={18} />
            Prompts
          </Link>
          <Link to="/requests" activeProps={{ className: "active" }}>
            <ListFilter size={18} />
            Requests
          </Link>
          <Link to="/settings" activeProps={{ className: "active" }}>
            <SettingsIcon size={18} />
            Settings
          </Link>
        </nav>
        <LogoutButton />
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
