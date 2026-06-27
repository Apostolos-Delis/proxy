import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlayCircle, RefreshCw, Save } from "lucide-react";
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
import { MenuSelect } from "../table/MenuSelect";
import { StatusIndicator } from "../ui";
import {
  probeProviderCredential,
  refreshBedrockModelCatalog,
  updateProviderCredential,
  type ProviderAccountSummary
} from "./data";
import {
  bedrockCredentialModeLabel,
  type BedrockCredentialMode
} from "./createCredentialWizard";
import { ProviderHealthSection } from "./healthViews";

const bedrockModeOptions: { value: BedrockCredentialMode; label: string }[] = [
  { value: "aws_bedrock_bearer_token", label: bedrockCredentialModeLabel("aws_bedrock_bearer_token") },
  { value: "aws_static_keys", label: bedrockCredentialModeLabel("aws_static_keys") },
  { value: "aws_default_chain", label: bedrockCredentialModeLabel("aws_default_chain") },
  { value: "aws_profile", label: bedrockCredentialModeLabel("aws_profile") }
];

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
          <StatusIndicator status={account.status} />
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
          {isBedrockAccount(account) ? <Fact label="Source"><span className="mono">{account.credentialSourceCategory ?? "unknown"}</span></Fact> : null}
          {isBedrockAccount(account) ? <Fact label="Region"><span className="mono">{account.region ?? "unknown"}</span></Fact> : null}
          {isBedrockAccount(account) ? <Fact label="Discovery"><span className="mono">{account.discoveryRegions.join(", ") || "none"}</span></Fact> : null}
          <Fact label="Owner">{account.ownerUserId ? <span className="mono">{compactId(account.ownerUserId, 8)}</span> : "organization"}</Fact>
          <Fact label="Bound keys"><span className="mono">{boundKeys.length}</span></Fact>
          <Fact label="Created">{formatDateTime(account.createdAt)}</Fact>
          <Fact label="Last used">{account.lastUsedAt ? formatDateTime(account.lastUsedAt) : "never"}</Fact>
        </div>
        {isBedrockAccount(account) ? <BedrockSettingsSection key={account.id} account={account} /> : null}
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
type ProviderProbeOperation = "full" | "model_access" | "streaming";

function ProviderProbeSection({ account }: { account: ProviderAccountSummary }) {
  const [model, setModel] = useState(initialProbeModel(account));
  const queryClient = useQueryClient();
  const probeMutation = useMutation({
    mutationFn: (input: { model: string; operation: ProviderProbeOperation }) => probeProviderCredential({
      providerAccountId: account.id,
      model: input.model,
      operation: input.operation === "full" ? undefined : input.operation
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
    }
  });
  const trimmedModel = model.trim();
  const pending = probeMutation.isPending;
  const bedrock = isBedrockAccount(account);
  const pendingOperation = pending ? probeMutation.variables?.operation ?? "full" : null;
  let primaryProbeLabel = bedrock ? "Test access" : "Probe";
  if (pendingOperation === "model_access" || pendingOperation === "full") primaryProbeLabel = "Probing";
  const runProbe = (operation: ProviderProbeOperation) => {
    if (!trimmedModel || pending) return;
    probeMutation.mutate({ model: trimmedModel, operation });
  };
  return (
    <section className="provider-probe-panel">
      <div className="card-head">
        <div className="card-title"><PlayCircle />Probe</div>
        {probeMutation.data ? <StatusIndicator tone={probeStatusTone(probeMutation.data)}>{probeLabel(probeMutation.data)}</StatusIndicator> : null}
      </div>
      <form
        className="provider-probe-form"
        onSubmit={(event) => {
          event.preventDefault();
          runProbe(bedrock ? "model_access" : "full");
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
          <PlayCircle />{primaryProbeLabel}
        </button>
        {bedrock ? (
          <button className="btn" type="button" disabled={!trimmedModel || pending} onClick={() => runProbe("streaming")}>
            <PlayCircle />{pendingOperation === "streaming" ? "Testing" : "Test stream"}
          </button>
        ) : null}
      </form>
      {probeMutation.error ? <div className="empty compact-empty">{probeMutation.error.message}</div> : null}
      {probeMutation.data ? <ProviderProbeResultView result={probeMutation.data} /> : null}
    </section>
  );
}

function ProviderProbeResultView({ result }: { result: ProviderProbeResult }) {
  return (
    <div className="fact-grid provider-probe-result">
      <Fact label="Result"><StatusIndicator tone={probeStatusTone(result)}>{probeLabel(result)}</StatusIndicator></Fact>
      <Fact label="Health">{result.healthStatus}</Fact>
      <Fact label="Latency">{formatDurationMs(result.latencyMs)}</Fact>
      <Fact label="Status"><span className="mono">{result.statusCode ?? "none"}</span></Fact>
      <Fact label="Checked">{formatDateTime(result.checkedAt)}</Fact>
      <Fact label="State">{result.stateUpdated ? "updated" : "event only"}</Fact>
      {probeCategory(result) ? <Fact label="Category"><span className="mono">{probeCategory(result)}</span></Fact> : null}
      {result.errorType ? <Fact label="Error">{result.errorType}</Fact> : null}
      {result.message ? <Fact label="Message">{result.message}</Fact> : null}
    </div>
  );
}

type BedrockSettingsDraft = {
  name: string;
  credentialMode: BedrockCredentialMode;
  region: string;
  discoveryRegions: string;
  endpointOverride: string;
  bearerToken: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

function BedrockSettingsSection({ account }: { account: ProviderAccountSummary }) {
  const [draft, setDraft] = useState<BedrockSettingsDraft>(() => initialBedrockSettingsDraft(account));
  const queryClient = useQueryClient();
  const updateMutation = useMutation({
    mutationFn: updateProviderCredential,
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
      if (updated) {
        setDraft((current) => ({
          ...current,
          name: updated.name ?? current.name,
          credentialMode: bedrockModeValue(updated.credentialMode) ?? current.credentialMode,
          region: updated.region ?? current.region,
          discoveryRegions: updated.discoveryRegions.join(", ") || current.discoveryRegions,
          endpointOverride: updated.endpointOverride ?? "",
          bearerToken: "",
          accessKeyId: "",
          secretAccessKey: "",
          sessionToken: ""
        }));
      }
    }
  });
  const refreshMutation = useMutation({
    mutationFn: () => refreshBedrockModelCatalog(account.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["provider-accounts"] }),
        queryClient.invalidateQueries({ queryKey: ["routing-model-catalog"] })
      ]);
    }
  });
  const blocker = bedrockSettingsBlocker(draft, account);
  return (
    <section className="bedrock-settings-panel">
      <div className="card-head">
        <div className="card-title"><Save />Bedrock setup</div>
        {updateMutation.data ? <StatusIndicator status="updated" /> : null}
      </div>
      <form
        className="bedrock-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (blocker || updateMutation.isPending) return;
          updateMutation.mutate(bedrockUpdateInput(account.id, draft));
        }}
      >
        <div className="routing-create-grid key-create-grid">
          <label className="routing-create-field">
            <span>Label</span>
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <div className="routing-create-field">
            <span>Credential mode</span>
            <BedrockModeSelect
              value={draft.credentialMode}
              onChange={(credentialMode) => setDraft({ ...draft, credentialMode })}
            />
          </div>
          <label className="routing-create-field">
            <span>Runtime region</span>
            <input value={draft.region} onChange={(event) => setDraft({ ...draft, region: event.target.value })} />
          </label>
          <label className="routing-create-field">
            <span>Discovery regions</span>
            <input value={draft.discoveryRegions} onChange={(event) => setDraft({ ...draft, discoveryRegions: event.target.value })} />
          </label>
          <label className="routing-create-field">
            <span>Runtime endpoint override</span>
            <input value={draft.endpointOverride} onChange={(event) => setDraft({ ...draft, endpointOverride: event.target.value })} />
          </label>
        </div>
        {draft.credentialMode === "aws_bedrock_bearer_token" ? (
          <label className="routing-create-field">
            <span>Replace bearer token</span>
            <input
              value={draft.bearerToken}
              onChange={(event) => setDraft({ ...draft, bearerToken: event.target.value })}
              placeholder={account.credentialMode === "aws_bedrock_bearer_token" ? "Leave blank to keep current token" : "Required when switching modes"}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ) : null}
        {draft.credentialMode === "aws_static_keys" ? (
          <div className="routing-create-grid key-create-grid">
            <label className="routing-create-field">
              <span>Replace access key ID</span>
              <input value={draft.accessKeyId} onChange={(event) => setDraft({ ...draft, accessKeyId: event.target.value })} autoComplete="off" spellCheck={false} />
            </label>
            <label className="routing-create-field">
              <span>Replace secret access key</span>
              <input value={draft.secretAccessKey} onChange={(event) => setDraft({ ...draft, secretAccessKey: event.target.value })} autoComplete="off" spellCheck={false} />
            </label>
            <label className="routing-create-field">
              <span>Replace session token</span>
              <input value={draft.sessionToken} onChange={(event) => setDraft({ ...draft, sessionToken: event.target.value })} autoComplete="off" spellCheck={false} />
            </label>
          </div>
        ) : null}
        {blocker ? <div className="empty compact-empty">{blocker}</div> : null}
        {updateMutation.error ? <div className="empty compact-empty">{updateMutation.error.message}</div> : null}
        <div className="bedrock-settings-actions">
          <button className="btn btn-primary" type="submit" disabled={Boolean(blocker) || updateMutation.isPending}>
            <Save />{updateMutation.isPending ? "Saving" : "Save setup"}
          </button>
          <button className="btn" type="button" disabled={refreshMutation.isPending} onClick={() => refreshMutation.mutate()}>
            <RefreshCw />{refreshMutation.isPending ? "Refreshing" : "Refresh discovery"}
          </button>
        </div>
      </form>
      {refreshMutation.error ? <div className="empty compact-empty">{refreshMutation.error.message}</div> : null}
      {refreshMutation.data ? <BedrockRefreshResult result={refreshMutation.data} /> : null}
    </section>
  );
}

function BedrockModeSelect({ value, onChange }: {
  value: BedrockCredentialMode;
  onChange: (mode: BedrockCredentialMode) => void;
}) {
  return (
    <MenuSelect
      ariaLabel="Bedrock credential mode"
      value={value}
      options={bedrockModeOptions}
      onChange={(mode) => onChange(mode as BedrockCredentialMode)}
    />
  );
}

type BedrockRefreshResultModel = NonNullable<Awaited<ReturnType<typeof refreshBedrockModelCatalog>>>;

function BedrockRefreshResult({ result }: { result: BedrockRefreshResultModel }) {
  return (
    <div className="fact-grid bedrock-refresh-result">
      <Fact label="Result"><StatusIndicator status={result.status} tone={result.status === "completed" ? "success" : "danger"} /></Fact>
      <Fact label="Regions"><span className="mono">{result.regions.join(", ")}</span></Fact>
      <Fact label="Seen"><span className="mono">{result.modelsSeen}</span></Fact>
      <Fact label="Applied"><span className="mono">{result.modelsApplied}</span></Fact>
      <Fact label="Inserted"><span className="mono">{result.inserted}</span></Fact>
      <Fact label="Updated"><span className="mono">{result.updated}</span></Fact>
      <Fact label="Skipped"><span className="mono">{result.skipped}</span></Fact>
      {result.error ? <Fact label="Error">{result.error}</Fact> : null}
      {result.errors.length > 0 ? <Fact label="Region errors">{result.errors.map((error) => `${error.region}:${error.error}`).join(", ")}</Fact> : null}
    </div>
  );
}

function initialBedrockSettingsDraft(account: ProviderAccountSummary): BedrockSettingsDraft {
  return {
    name: account.name,
    credentialMode: bedrockModeValue(account.credentialMode) ?? "aws_bedrock_bearer_token",
    region: account.region ?? "us-east-1",
    discoveryRegions: account.discoveryRegions.join(", ") || account.region || "us-east-1",
    endpointOverride: account.endpointOverride ?? "",
    bearerToken: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: ""
  };
}

function bedrockSettingsBlocker(draft: BedrockSettingsDraft, account: ProviderAccountSummary) {
  if (!draft.name.trim()) return "Label is required.";
  if (!draft.region.trim()) return "Runtime region is required.";
  if (bedrockDiscoveryRegionList(draft).length === 0) return "Enter at least one discovery region.";
  if (
    draft.credentialMode === "aws_bedrock_bearer_token" &&
    account.credentialMode !== "aws_bedrock_bearer_token" &&
    !draft.bearerToken.trim()
  ) {
    return "Bearer token is required when switching to bearer-token mode.";
  }
  if (draft.credentialMode === "aws_static_keys") {
    const replacingSecret = Boolean(draft.accessKeyId.trim() || draft.secretAccessKey.trim() || draft.sessionToken.trim());
    const needsSecret = account.credentialMode !== "aws_static_keys" || replacingSecret;
    if (needsSecret && !draft.accessKeyId.trim()) return "AWS access key ID is required.";
    if (needsSecret && !draft.secretAccessKey.trim()) return "AWS secret access key is required.";
  }
  return null;
}

function bedrockUpdateInput(providerAccountId: string, draft: BedrockSettingsDraft) {
  return {
    providerAccountId,
    name: draft.name.trim(),
    credentialMode: draft.credentialMode,
    region: draft.region.trim(),
    discoveryRegions: bedrockDiscoveryRegionList(draft),
    endpointOverride: draft.endpointOverride.trim() || null,
    ...(draft.credentialMode === "aws_bedrock_bearer_token" && draft.bearerToken.trim()
      ? { apiKey: draft.bearerToken.trim() }
      : {}),
    ...(draft.credentialMode === "aws_static_keys" && (draft.accessKeyId.trim() || draft.secretAccessKey.trim() || draft.sessionToken.trim())
      ? {
          accessKeyId: draft.accessKeyId.trim(),
          secretAccessKey: draft.secretAccessKey.trim(),
          sessionToken: draft.sessionToken.trim() || undefined
        }
      : {})
  };
}

function bedrockDiscoveryRegionList(draft: Pick<BedrockSettingsDraft, "discoveryRegions">) {
  return draft.discoveryRegions
    .split(/[,\s]+/)
    .map((region) => region.trim())
    .filter(Boolean);
}

function bedrockModeValue(value: string | null | undefined): BedrockCredentialMode | undefined {
  return bedrockModeOptions.find((option) => option.value === value)?.value;
}

function isBedrockAccount(account: ProviderAccountSummary) {
  return Boolean(account.credentialMode || account.region || account.credentialSourceCategory);
}

function probeCategory(result: ProviderProbeResult) {
  if (!isRecord(result.dimensions)) return null;
  const failure = result.dimensions.failure;
  if (!isRecord(failure)) return null;
  const metadata = isRecord(failure.metadata) ? failure.metadata : undefined;
  return stringValue(metadata?.bedrockErrorKind) ?? stringValue(failure.category);
}

function initialProbeModel(account: ProviderAccountSummary) {
  return account.health?.modelHealth[0]?.model ?? "";
}

function probeLabel(result: ProviderProbeResult) {
  if (result.status === "success") return "Success";
  if (result.status === "partial") return "Partial";
  return "Failed";
}

function probeStatusTone(result: ProviderProbeResult): "success" | "warn" | "danger" {
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
  if (apiKey.revokedAt) return <StatusIndicator status="revoked" />;
  if (binding?.status && binding.status !== "active") return <StatusIndicator status={binding.status} />;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
