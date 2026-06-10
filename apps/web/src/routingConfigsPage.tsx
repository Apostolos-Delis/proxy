import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, Plus, Settings2 } from "lucide-react";

import { fetchRoutingConfigs } from "./routing/data";
import { RoutingConfigCard } from "./routing/configCard";
import { GlassCard, PageState, PageTitle } from "./ui";

export function RoutingConfigsPage() {
  const query = useQuery({ queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs });

  if (query.isLoading) return <PageState title="Routing configs" label="Loading routing configs" />;
  if (query.error) return <PageState title="Routing configs" label={query.error.message} />;

  const configs = query.data ?? [];
  return (
    <div className="page page-enter">
      <PageTitle
        title="Routing configs"
        subtitle="Model tiers and routing rules for proxied coding-agent traffic."
        actions={
          <>
            <Link to="/settings" className="btn"><Settings2 />Runtime settings</Link>
            <Link to="/routing-configs/new" className="btn btn-primary"><Plus />New config</Link>
          </>
        }
      />
      {configs.length === 0 ? (
        <RoutingConfigsEmpty />
      ) : (
        <div className="config-card-grid">
          {configs.map((config) => <RoutingConfigCard key={config.id} config={config} />)}
        </div>
      )}
    </div>
  );
}

function RoutingConfigsEmpty() {
  return (
    <GlassCard className="empty-state routing-configs-empty">
      <GitBranch />
      <strong>No routing configs found</strong>
      <span>Seed a routing config before adding UI-managed variants.</span>
    </GlassCard>
  );
}
