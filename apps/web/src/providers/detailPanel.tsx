import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlayCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Drawer } from "../drawer";
import { compactId, formatDateTime, formatDurationMs } from "../format";
import {
  Fact,
  KeyUsageSection,
  RecentKeyRequestsSection,
  REQUEST_LIMIT,
  useKeyTraffic,
  type KeyTrafficRequest
} from "../keyTraffic";
import { fetchApiKeys, type ApiKeySummary } from "../routing/data";
import { Badge, StatusBadge } from "../ui";
import { probeProviderCredential, type ProviderAccountSummary } from "./data";
import { ProviderHealthSection } from "./healthViews";

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
          <Fact label="Base URL">{account.baseUrl ? <span className="mono">{account.baseUrl}</span> : "provider default"}</Fact>
          <Fact label="Owner">{account.ownerUserId ? <span className="mono">{compactId(account.ownerUserId, 8)}</span> : "organization"}</Fact>
          <Fact label="Bound keys"><span className="mono">{boundKeys.length}</span></Fact>
          <Fact label="Created">{formatDateTime(account.createdAt)}</Fact>
          <Fact label="Last used">{account.lastUsedAt ? formatDateTime(account.lastUsedAt) : "never"}</Fact>
        </div>
        <ProviderHealthSection account={account} />
        <ProviderProbeSection key={account.id} account={account} />
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

type ProviderProbeResult = NonNullable<Awaited<ReturnType<typeof probeProviderCredential>>>;

function ProviderProbeSection({ account }: { account: ProviderAccountSummary }) {
  const [model, setModel] = useState(initialProbeModel(account));
  const queryClient = useQueryClient();
  const probeMutation = useMutation({
    mutationFn: (probeModel: string) => probeProviderCredential({
      providerAccountId: account.id,
      model: probeModel
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
    }
  });
  const trimmedModel = model.trim();
  const pending = probeMutation.isPending;
  return (
    <section className="provider-probe-panel">
      <div className="card-head">
        <div className="card-title"><PlayCircle />Probe</div>
        {probeMutation.data ? <Badge variant={probeBadgeVariant(probeMutation.data)} dot>{probeLabel(probeMutation.data)}</Badge> : null}
      </div>
      <form
        className="provider-probe-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmedModel || pending) return;
          probeMutation.mutate(trimmedModel);
        }}
      >
        <label className="provider-probe-field">
          <span>Model</span>
          <input
            type="text"
            value={model}
            placeholder="model id"
            onChange={(event) => setModel(event.currentTarget.value)}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={!trimmedModel || pending}>
          <PlayCircle />{pending ? "Probing" : "Probe"}
        </button>
      </form>
      {probeMutation.error ? <div className="empty compact-empty">{probeMutation.error.message}</div> : null}
      {probeMutation.data ? <ProviderProbeResultView result={probeMutation.data} /> : null}
    </section>
  );
}

function ProviderProbeResultView({ result }: { result: ProviderProbeResult }) {
  return (
    <div className="fact-grid provider-probe-result">
      <Fact label="Result"><Badge variant={probeBadgeVariant(result)} dot>{probeLabel(result)}</Badge></Fact>
      <Fact label="Health">{result.healthStatus}</Fact>
      <Fact label="Latency">{formatDurationMs(result.latencyMs)}</Fact>
      <Fact label="Status"><span className="mono">{result.statusCode ?? "none"}</span></Fact>
      <Fact label="Checked">{formatDateTime(result.checkedAt)}</Fact>
      <Fact label="State">{result.stateUpdated ? "updated" : "event only"}</Fact>
      {result.errorType ? <Fact label="Error">{result.errorType}</Fact> : null}
      {result.message ? <Fact label="Message">{result.message}</Fact> : null}
    </div>
  );
}

function initialProbeModel(account: ProviderAccountSummary) {
  return account.health?.modelHealth[0]?.model ?? "";
}

function probeLabel(result: ProviderProbeResult) {
  if (result.status === "success") return "Success";
  if (result.status === "partial") return "Partial";
  return "Failed";
}

function probeBadgeVariant(result: ProviderProbeResult): "success" | "warn" | "danger" {
  if (result.status === "success") return "success";
  if (result.status === "partial") return "warn";
  return "danger";
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
