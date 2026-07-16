import { Drawer } from "../drawer";
import { compactId, formatDateTime } from "../format";
import {
  Fact,
  KeyUsageSection,
  RecentKeyRequestsSection,
  REQUEST_LIMIT,
  useKeyTraffic
} from "../keyTraffic";
import type { ApiKeySummary } from "./data";
import { StatusIndicator } from "../ui";
import { apiKeyStatus } from "./apiKeyTableData";

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
          <StatusIndicator status={apiKeyStatus(apiKey)} />
        </span>
      )}
      storageKey="key-panel-width"
      onClose={onClose}
    >
      <div className="key-panel">
        <div className="fact-grid key-panel-facts">
          <Fact label="Key ID"><span className="mono" title={apiKey.id}>{compactId(apiKey.id, 8)}</span></Fact>
          <Fact label="Owner">{apiKey.userId ? <span className="mono">{apiKey.userId}</span> : "organization"}</Fact>
          <Fact label="Access profile">{apiKey.accessProfile?.name ?? "Unassigned"}</Fact>
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
