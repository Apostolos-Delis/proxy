import { useQuery } from "@tanstack/react-query";
import { Boxes, Network, Plus } from "lucide-react";
import { useState } from "react";

import { apiBase } from "./graphql";
import { CreateModelModal } from "./models/createModelModal";
import {
  deploymentOptions,
  fetchGatewayModels,
  logicalModelSummaries,
  routerDefaults,
  type LogicalModelSummary
} from "./modelsPageData";
import { Badge, GlassCard, PageState, PageTitle, StatusIndicator } from "./ui";

const wireEndpoints = [
  { method: "GET", path: "/v1/models", operation: "model.list", wire: "gateway catalog", clients: "Models granted to the calling key" },
  { method: "POST", path: "/v1/responses", operation: "text.generate", wire: "openai-responses", clients: "OpenAI SDK, Codex" },
  { method: "WS", path: "/v1/responses", operation: "text.generate", wire: "openai-responses", clients: "Realtime Responses; native targets only" },
  { method: "POST", path: "/v1/chat/completions", operation: "text.generate", wire: "openai-chat", clients: "OpenAI-compatible SDKs, opencode" },
  { method: "POST", path: "/v1/messages", operation: "text.generate", wire: "anthropic-messages", clients: "Anthropic SDK, Claude Code" },
  { method: "POST", path: "/v1/messages/count_tokens", operation: "text.count_tokens", wire: "anthropic-messages", clients: "Anthropic token counting; native targets only" }
] as const;

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
      <EndpointsCard />
      <ModelsCard models={models} />
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
    <GlassCard>
      <div className="card-head">
        <div>
          <div className="card-title"><Network />API endpoints</div>
          <div className="stat-sub">
            Point an OpenAI- or Anthropic-compatible client at <span className="code-pill">{apiBase}</span> and
            request a logical model by slug. These are all model-facing API routes.
          </div>
        </div>
      </div>
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
          {wireEndpoints.map((endpoint) => (
            <tr key={`${endpoint.method}:${endpoint.path}`}>
              <td><span className="mono">{endpoint.method} {endpoint.path}</span></td>
              <td><span className="mono">{endpoint.operation}</span></td>
              <td><Badge>{endpoint.wire}</Badge></td>
              <td><span className="faint">{endpoint.clients}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </GlassCard>
  );
}

function ModelsCard({ models }: { models: LogicalModelSummary[] }) {
  return (
    <GlassCard>
      <div className="card-head">
        <div>
          <div className="card-title"><Boxes />Logical models</div>
          <div className="stat-sub">Requesting a direct model skips routing; router models classify each request across their targets.</div>
        </div>
      </div>
      {models.length === 0 ? (
        <div className="empty compact-empty">No logical models configured.</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Model</th>
              <th>Resolution</th>
              <th>Routes to</th>
              <th>Wires</th>
              <th>Granted to</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => <ModelRow key={model.id} model={model} />)}
          </tbody>
        </table>
      )}
    </GlassCard>
  );
}

function ModelRow({ model }: { model: LogicalModelSummary }) {
  return (
    <tr>
      <td>
        <div className="pricing-model">
          <span>{model.name}</span>
          <span className="mono">{model.slug}</span>
          {model.description ? <span className="faint">{model.description}</span> : null}
        </div>
      </td>
      <td>
        <Badge variant={model.kind === "router" ? "accent" : undefined}>
          {model.kind === "router" ? "auto-router" : "direct"}
        </Badge>
      </td>
      <td>
        <div className="pricing-model">
          {model.targets.length === 0 ? <span className="faint">No targets</span> : null}
          {model.targets.map((target) => (
            <span key={target.targetId} className={target.available ? undefined : "faint"}>
              <span className="mono">{target.upstreamModelId}</span>
              <span className="faint">
                {" "}via {target.provider}{targetAvailabilityLabel(target)}
              </span>
            </span>
          ))}
          {model.classifierDeployment ? (
            <span className="faint">Classifier: {model.classifierDeployment}</span>
          ) : null}
          {model.routingPolicy ? (
            <span className="faint">Classifier instructions: {model.routingPolicy}</span>
          ) : null}
        </div>
      </td>
      <td>
        <div className="pricing-model">
          {model.wires.length === 0 ? <span className="faint">None</span> : null}
          {model.wires.map((wire) => <span key={wire} className="mono">{wire}</span>)}
        </div>
      </td>
      <td>
        {model.profiles.length === 0
          ? <span className="faint">No access profiles</span>
          : <span>{model.profiles.join(", ")}</span>}
      </td>
      <td><StatusIndicator status={logicalModelStatus(model)} /></td>
    </tr>
  );
}

function logicalModelStatus(model: LogicalModelSummary) {
  if (!model.enabled) return "disabled";
  return model.available ? "active" : "unavailable";
}

function targetAvailabilityLabel(target: LogicalModelSummary["targets"][number]) {
  if (target.available) return "";
  if (target.enabled) return " (unavailable)";
  return " (disabled)";
}
