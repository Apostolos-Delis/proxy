import { Link } from "@tanstack/react-router";
import { BarChart3, KeyRound } from "lucide-react";

import { GlassCard, PageTitle } from "./ui";

export function KeysPage() {
  return (
    <div className="page page-enter">
      <PageTitle
        title="API keys"
        subtitle="Keys carry the permissions of their owner. Keep them secret."
        actions={<Link to="/usage" className="btn"><BarChart3 />Key usage</Link>}
      />
      <GlassCard className="empty-state">
        <KeyRound />
        <strong>API key admin endpoint not implemented</strong>
        <span>The proxy stores API keys as hashes today. Add an admin API key list endpoint before rendering key inventory or spend limits here.</span>
      </GlassCard>
    </div>
  );
}
