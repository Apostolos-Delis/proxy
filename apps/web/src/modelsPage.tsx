import { useQuery } from "@tanstack/react-query";
import { Network, Plus } from "lucide-react";
import { useState } from "react";
import { GATEWAY_MODEL_ENDPOINTS, type GatewayModelEndpoint } from "@proxy/schema";

import { apiBase } from "./graphql";
import { CreateModelModal } from "./models/createModelModal";
import { ModelsTable } from "./models/modelsTable";
import {
  deploymentOptions,
  fetchGatewayModels,
  logicalModelSummaries,
  routerDefaults
} from "./modelsPageData";
import { Badge, GlassCard, PageState, PageTitle } from "./ui";

const endpointClients: Record<GatewayModelEndpoint["id"], string> = {
  "models": "Models granted to the calling key",
  "responses-http": "OpenAI SDK, Codex",
  "responses-websocket": "Realtime Responses; native targets only",
  "chat-completions": "OpenAI-compatible SDKs, opencode",
  "messages": "Anthropic SDK, Claude Code",
  "count-tokens": "Anthropic token counting; native targets only"
};

export function ModelsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const modelsQuery = useQuery({ queryKey: ["gateway-models"], queryFn: fetchGatewayModels });

  if (modelsQuery.isLoading) return <PageState title="Models" label="Loading gateway models" />;
  if (modelsQuery.error) return <PageState title="Models" label={modelsQuery.error.message} />;

  const data = modelsQuery.data!;
  const models = logicalModelSummaries(data);
  return (
    <div className="page page-enter models-page">
      <PageTitle
        title="Models"
        subtitle="Logical models are the names callers request; each resolves directly or through a router to provider deployments."
        actions={(
          <button className="btn btn-primary" type="button" onClick={() => setShowCreate(true)}>
            <Plus />
            New model
          </button>
        )}
      />
      <ModelsTable models={models} />
      <EndpointsCard />
      {showCreate ? (
        <CreateModelModal
          options={deploymentOptions(data)}
          defaults={routerDefaults(data)}
          onClose={() => setShowCreate(false)}
        />
      ) : null}
    </div>
  );
}

function EndpointsCard() {
  return (
    <GlassCard className="models-endpoints-card">
      <div className="card-head">
        <div>
          <div className="card-title"><Network />API endpoints</div>
          <div className="stat-sub">
            Point an OpenAI- or Anthropic-compatible client at <span className="code-pill">{apiBase}</span> and
            request a logical model by slug. These are all model-facing API routes.
          </div>
        </div>
      </div>
      <div className="models-endpoints-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Operation</th>
              <th>API wire</th>
              <th>Used by</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(GATEWAY_MODEL_ENDPOINTS).map((endpoint) => (
              <tr key={endpoint.id}>
                <td><span className="mono">{endpoint.method} {endpoint.path}</span></td>
                <td><span className="mono">{endpoint.operationId}</span></td>
                <td><Badge>{endpoint.wireId ?? "gateway catalog"}</Badge></td>
                <td><span className="faint">{endpointClients[endpoint.id]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GlassCard>
  );
}
