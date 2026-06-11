import { Link } from "@tanstack/react-router";

import { Drawer } from "../drawer";
import { compactId, formatDateTime } from "../format";
import {
  Fact,
  KeyUsageSection,
  RecentKeyRequestsSection,
  REQUEST_LIMIT,
  useKeyTraffic
} from "../keyTraffic";
import type { ApiKeySummary } from "../routing/data";
import { StatusBadge } from "../ui";
import { apiKeyStatus, scopeTitle } from "./apiKeyTableData";

export function ApiKeyDetailPanel({ apiKey, onClose }: {
  apiKey: ApiKeySummary;
  onClose: () => void;
}) {
  const { range, setRange, metric, setMetric, requestsQuery } = useKeyTraffic();
  const allRequests = requestsQuery.data?.requests ?? [];
  const keyRequests = allRequests.filter((request) => request.apiKeyId === apiKey.id);

  return (
    <Drawer
      label={`API key ${apiKey.name}`}
      title={apiKey.name}
      subtitle={(
        <span className="row gap-8">
          {apiKey.scopes.map((scope) => (
            <span key={scope} className="code-pill" title={scopeTitle(scope)}>{scope}</span>
          ))}
          <StatusBadge status={apiKeyStatus(apiKey)} />
        </span>
      )}
      storageKey="key-panel-width"
      onClose={onClose}
    >
      <div className="key-panel">
        <div className="fact-grid key-panel-facts">
          <Fact label="Key ID"><span className="mono" title={apiKey.id}>{compactId(apiKey.id, 8)}</span></Fact>
          <Fact label="Owner">{apiKey.userId ? <span className="mono">{apiKey.userId}</span> : "organization"}</Fact>
          <Fact label="Routing config">
            {apiKey.routingConfig ? (
              <Link to="/routing-configs/$configId" params={{ configId: apiKey.routingConfig.id }} className="session-link">
                {apiKey.routingConfig.name}
              </Link>
            ) : "Organization default"}
          </Fact>
          <Fact label="Created">{formatDateTime(apiKey.createdAt)}</Fact>
          <Fact label="Last used">{apiKey.lastUsedAt ? formatDateTime(apiKey.lastUsedAt) : "never"}</Fact>
          <Fact label="Expires">{apiKey.expiresAt ? formatDateTime(apiKey.expiresAt) : "never"}</Fact>
        </div>
        {requestsQuery.error ? <div className="empty">{requestsQuery.error.message}</div> : (
          <>
            <KeyUsageSection
              loading={requestsQuery.isLoading}
              requests={keyRequests}
              truncated={allRequests.length >= REQUEST_LIMIT}
              range={range}
              onRangeChange={setRange}
              metric={metric}
              onMetricChange={setMetric}
              caption="Traffic attributed to this API key."
            />
            <ProviderKeysSection apiKey={apiKey} />
            <RecentKeyRequestsSection
              requests={keyRequests}
              logsSearch={{ adv: [["apiKey", "equals", apiKey.id, "and"]] }}
            />
          </>
        )}
      </div>
    </Drawer>
  );
}

function ProviderKeysSection({ apiKey }: { apiKey: ApiKeySummary }) {
  return (
    <section>
      <div className="card-title">Provider keys</div>
      {apiKey.providerCredentials.length === 0 ? (
        <div className="empty">No provider key bound — traffic uses the organization's default credentials.</div>
      ) : (
        <div className="key-bound-list">
          {apiKey.providerCredentials.map((binding) => (
            <Link
              key={`${binding.provider}:${binding.providerAccountId}`}
              to="/provider-keys"
              search={{ key: binding.providerAccountId }}
              className="key-bound-row"
            >
              <span className="code-pill">{binding.provider}</span>
              <strong>{binding.name ?? compactId(binding.providerAccountId, 8)}</strong>
              {binding.status && binding.status !== "active" ? <StatusBadge status={binding.status} /> : null}
              <span className="mono faint" title={binding.providerAccountId}>{compactId(binding.providerAccountId, 8)}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
