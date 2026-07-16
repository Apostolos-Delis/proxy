import { useQuery } from "@tanstack/react-query";
import { Boxes, Network, Plus } from "lucide-react";
import { useState } from "react";
import { GATEWAY_MODEL_ENDPOINTS, type GatewayModelEndpoint } from "@proxy/schema";

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
            <span className="faint">
              Classifier: {model.classifierDeployment}
              {model.classifierReasonCodes.length > 0
                ? ` (${readinessReasonLabel(model.classifierReasonCodes)})`
                : ""}
            </span>
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
      <td>
        <div className="pricing-model">
          <StatusIndicator status={logicalModelStatus(model)} />
          {!model.available && model.reasonCodes.length > 0
            ? <span className="faint">{readinessReasonLabel(model.reasonCodes)}</span>
            : null}
        </div>
      </td>
    </tr>
  );
}

function logicalModelStatus(model: LogicalModelSummary) {
  if (!model.enabled) return "disabled";
  return model.available ? "active" : "unavailable";
}

function targetAvailabilityLabel(target: LogicalModelSummary["targets"][number]) {
  if (target.available) return "";
  return ` (${readinessReasonLabel(target.reasonCodes)})`;
}

function readinessReasonLabel(reasonCodes: string[]) {
  return reasonCodes.map((reason) => reason.replaceAll("_", " ")).join(", ");
}
