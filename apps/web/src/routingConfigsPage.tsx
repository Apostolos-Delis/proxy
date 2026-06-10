import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, Plus, Settings2 } from "lucide-react";
import { useState } from "react";

import { fetchRoutingConfigs } from "./routing/data";
import { RoutingConfigCard } from "./routing/configCard";
import { GlassCard, PageState, PageTitle, Segmented } from "./ui";

export function RoutingConfigsPage() {
  const [view, setView] = useState<"active" | "archived">("active");
  const query = useQuery({ queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs });

  if (query.isLoading) return <PageState title="Routing configs" label="Loading routing configs" />;
  if (query.error) return <PageState title="Routing configs" label={query.error.message} />;

  const configs = query.data ?? [];
  const archived = configs.filter((config) => config.status === "archived");
  const active = configs.filter((config) => config.status !== "archived");
  const visible = view === "archived" && archived.length > 0 ? archived : active;
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
      {archived.length > 0 ? (
        <div className="config-view-toggle">
          <Segmented
            options={[
              { value: "active", label: `Active (${active.length})` },
              { value: "archived", label: `Archived (${archived.length})` }
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      ) : null}
      {visible.length === 0 ? (
        <RoutingConfigsEmpty anyArchived={archived.length > 0} />
      ) : (
        <div className="config-card-grid">
          {visible.map((config) => <RoutingConfigCard key={config.id} config={config} />)}
        </div>
      )}
    </div>
  );
}

function RoutingConfigsEmpty({ anyArchived }: { anyArchived: boolean }) {
  return (
    <GlassCard className="empty-state routing-configs-empty">
      <GitBranch />
      <strong>{anyArchived ? "No active routing configs" : "No routing configs found"}</strong>
      <span>
        {anyArchived
          ? "Every config is archived. Create a new config to route traffic."
          : "Seed a routing config before adding UI-managed variants."}
      </span>
    </GlassCard>
  );
}
