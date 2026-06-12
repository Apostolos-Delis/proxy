import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Check, GitBranch, ListFilter, Plus, Settings2 } from "lucide-react";
import { useState } from "react";

import { fetchRoutingConfigs } from "./routing/data";
import { RoutingConfigCard } from "./routing/configCard";
import { GlassCard, PageState, PageTitle } from "./ui";

export function RoutingConfigsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const query = useQuery({ queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs });

  if (query.isLoading) return <PageState title="Routing configs" label="Loading routing configs" />;
  if (query.error) return <PageState title="Routing configs" label={query.error.message} />;

  const configs = query.data ?? [];
  const archived = configs.filter((config) => config.status === "archived");
  const active = configs.filter((config) => config.status !== "archived");
  const visible = showArchived ? [...active, ...archived] : active;
  return (
    <div className="page page-enter">
      <PageTitle
        title="Routing configs"
        subtitle="How requests pick a tier, a provider, and a model."
        actions={
          <>
            {archived.length > 0 ? (
              <button
                type="button"
                className={`chip${showArchived ? " active" : ""}`}
                aria-pressed={showArchived}
                onClick={() => setShowArchived((value) => !value)}
              >
                {showArchived ? <Check /> : <ListFilter />}
                Show archived
              </button>
            ) : null}
            <Link to="/settings" className="btn"><Settings2 />Runtime settings</Link>
            <Link to="/routing/new" className="btn btn-primary"><Plus />New config</Link>
          </>
        }
      />
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
