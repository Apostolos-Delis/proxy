import { Link } from "@tanstack/react-router";
import { GitBranch, Settings2 } from "lucide-react";

import { GlassCard, PageTitle } from "./ui";

export function RoutingConfigsPage() {
  return (
    <div className="page page-enter">
      <PageTitle
        title="Routing configs"
        subtitle="Model tiers, classifier settings, and API key assignment targets."
        actions={<Link to="/settings" className="btn"><Settings2 />Runtime settings</Link>}
      />
      <GlassCard className="empty-state">
        <GitBranch />
        <strong>Routing config inventory is wired</strong>
        <span>List rendering lands next, using the persisted routing config admin APIs.</span>
      </GlassCard>
    </div>
  );
}

export function RoutingConfigDetailPage({ configId }: { configId: string }) {
  return (
    <div className="page page-enter">
      <PageTitle
        title="Routing config"
        subtitle={configId}
        actions={<Link to="/routing-configs" className="btn">All configs</Link>}
      />
      <GlassCard className="empty-state">
        <GitBranch />
        <strong>Routing config detail is wired</strong>
        <span>Version history, tier mapping, and activation controls land in the detail ticket.</span>
      </GlassCard>
    </div>
  );
}
