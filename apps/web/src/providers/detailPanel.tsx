import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Drawer } from "../drawer";
import { compactId, formatDateTime } from "../format";
import {
  Fact,
  KeyUsageSection,
  RecentKeyRequestsSection,
  REQUEST_LIMIT,
  useKeyTraffic,
  type KeyTrafficRequest
} from "../keyTraffic";
import { fetchApiKeys, type ApiKeySummary } from "../routing/data";
import { StatusBadge } from "../ui";
import type { ProviderAccountSummary } from "./data";

export function ProviderKeyDetailPanel({ account, onClose }: {
  account: ProviderAccountSummary;
  onClose: () => void;
}) {
  const { range, setRange, metric, setMetric, requestsQuery } = useKeyTraffic();
  const { data: keysQueryData, error: keysQueryError, isLoading: keysQueryIsLoading } = useQuery({ queryKey: ["api-keys"], queryFn: fetchApiKeys });

  const boundKeys = (keysQueryData ?? []).filter((apiKey) =>
    apiKey.providerCredentials.some((credential) => credential.providerAccountId === account.id)
  );
  const allRequests = requestsQuery.data?.requests ?? [];
  const accountRequests = accountTraffic(allRequests, account, boundKeys);
  const error = keysQueryError ?? requestsQuery.error;

  return (
    <Drawer
      label={`Provider key ${account.name}`}
      title={account.name}
      subtitle={(
        <span className="row gap-8">
          <span className="code-pill">{account.provider}</span>
          <StatusBadge status={account.status} />
        </span>
      )}
      storageKey="key-panel-width"
      onClose={onClose}
    >
      <div className="key-panel">
        <div className="fact-grid key-panel-facts">
          <Fact label="Key ID"><span className="mono" title={account.id}>{compactId(account.id, 8)}</span></Fact>
          <Fact label="Secret"><span className="mono">{account.secretHint ?? "—"}</span></Fact>
          <Fact label="Owner">{account.ownerUserId ? <span className="mono">{compactId(account.ownerUserId, 8)}</span> : "organization"}</Fact>
          <Fact label="Bound keys"><span className="mono">{boundKeys.length}</span></Fact>
          <Fact label="Created">{formatDateTime(account.createdAt)}</Fact>
          <Fact label="Last used">{account.lastUsedAt ? formatDateTime(account.lastUsedAt) : "never"}</Fact>
        </div>
        {error ? <div className="empty">{error.message}</div> : (
          <>
            <KeyUsageSection
              loading={keysQueryIsLoading || requestsQuery.isLoading}
              empty={boundKeys.length === 0 ? "No API keys are bound to this provider key, so no traffic flows through it." : undefined}
              requests={accountRequests}
              truncated={allRequests.length >= REQUEST_LIMIT}
              range={range}
              onRangeChange={setRange}
              metric={metric}
              onMetricChange={setMetric}
              caption="Traffic from API keys currently bound to this provider key."
            />
            <BoundKeysSection boundKeys={boundKeys} accountId={account.id} />
            {boundKeys.length > 0 ? <RecentKeyRequestsSection requests={accountRequests} /> : null}
          </>
        )}
      </div>
    </Drawer>
  );
}

/** Requests served by this provider key: traffic on its provider from API keys bound to it. */
function accountTraffic(requests: KeyTrafficRequest[], account: ProviderAccountSummary, boundKeys: ApiKeySummary[]) {
  const boundKeyIds = new Set(boundKeys.map((apiKey) => apiKey.id));
  return requests.filter((request) =>
    request.provider === account.provider && request.apiKeyId != null && boundKeyIds.has(request.apiKeyId)
  );
}

function BoundKeysSection({ boundKeys, accountId }: { boundKeys: ApiKeySummary[]; accountId: string }) {
  return (
    <section>
      <div className="card-title">Bound API keys</div>
      {boundKeys.length === 0 ? (
        <div className="empty">
          Bind an API key on the <Link to="/api-keys" className="session-link">API keys</Link> page to route its traffic through this key.
        </div>
      ) : (
        <div className="key-bound-list">
          {boundKeys.map((apiKey) => (
            <Link key={apiKey.id} to="/api-keys" search={{ key: apiKey.id }} className="key-bound-row">
              <strong>{apiKey.name}</strong>
              <span className="mono faint" title={apiKey.id}>{compactId(apiKey.id, 8)}</span>
              {bindingStatus(apiKey, accountId)}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function bindingStatus(apiKey: ApiKeySummary, accountId: string): ReactNode {
  const binding = apiKey.providerCredentials.find((credential) => credential.providerAccountId === accountId);
  if (apiKey.revokedAt) return <StatusBadge status="revoked" />;
  if (binding?.status && binding.status !== "active") return <StatusBadge status={binding.status} />;
  return null;
}
