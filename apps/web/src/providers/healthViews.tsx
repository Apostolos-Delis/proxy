import { Activity, LockKeyhole } from "lucide-react";

import { compactId, formatDateTime } from "../format";
import { Fact } from "../keyTraffic";
import { Badge } from "../ui";
import type { ProviderCredentialRow } from "./credentialsTableData";
import type { ProviderAccountSummary } from "./data";
import {
  bedrockHealthMetadataSummary,
  modelHealthRows,
  providerHealthLabel,
  providerHealthTone,
  type ProviderHealthTone,
  type ProviderModelHealth
} from "./healthData";

export function ProviderCredentialHealthCell({ row }: { row: ProviderCredentialRow }) {
  if (row.kind === "default") return <span className="provider-health-empty">not tracked</span>;
  return <ProviderHealthBadge account={row.account} compact />;
}

export function ProviderHealthSection({ account }: { account: ProviderAccountSummary }) {
  const health = account.health;
  if (!health) {
    return (
      <section className="provider-health-panel">
        <div className="card-title"><Activity />Health</div>
        <div className="empty compact-empty">No health data recorded for this provider key yet.</div>
      </section>
    );
  }
  const models = modelHealthRows(health);
  const metadataSummary = bedrockHealthMetadataSummary(health.metadata);
  return (
    <section className="provider-health-panel">
      <div className="card-head">
        <div className="card-title"><Activity />Health</div>
        <ProviderHealthBadge account={account} />
      </div>
      <div className="fact-grid provider-health-facts">
        <Fact label="Cooldown">{health.cooldownUntil ? formatDateTime(health.cooldownUntil) : "none"}</Fact>
        <Fact label="Failures"><span className="mono">{health.consecutiveFailures}</span></Fact>
        <Fact label="Last error">{lastErrorLabel(health.lastErrorType, health.lastErrorAt)}</Fact>
        <Fact label="Last success">{health.lastSuccessAt ? formatDateTime(health.lastSuccessAt) : "none"}</Fact>
        <Fact label="Last checked">{health.lastCheckedAt ? formatDateTime(health.lastCheckedAt) : "not checked"}</Fact>
        {metadataSummary ? <Fact label="Bedrock detail">{metadataSummary}</Fact> : null}
      </div>
      <div className="provider-model-health">
        <div className="provider-model-health-head">
          <LockKeyhole />
          <strong>Model health</strong>
        </div>
        {models.length === 0 ? (
          <div className="empty compact-empty">No model lockouts recorded.</div>
        ) : (
          <div className="provider-model-health-list">
            {models.map((model) => <ProviderModelHealthRow key={`${model.providerAccountId}:${model.model}`} model={model} />)}
          </div>
        )}
      </div>
    </section>
  );
}

function ProviderHealthBadge({ account, compact = false }: { account: ProviderAccountSummary; compact?: boolean }) {
  const health = account.health;
  return (
    <div className="provider-health-cell" title={healthTitle(account)}>
      <Badge variant={badgeVariant(providerHealthTone(health))} dot>{providerHealthLabel(health)}</Badge>
      {compact ? <span className="provider-health-detail">{shortHealthDetail(health)}</span> : null}
    </div>
  );
}

function ProviderModelHealthRow({ model }: { model: ProviderModelHealth }) {
  return (
    <div className="provider-model-health-row">
      <div>
        <strong className="mono">{model.model}</strong>
        <span className="faint">{model.providerAccountId ? compactId(model.providerAccountId, 8) : "provider key"}</span>
      </div>
      <Badge variant={badgeVariant(providerHealthTone(model))} dot>{providerHealthLabel(model)}</Badge>
      <span className="provider-health-detail">{modelDetail(model)}</span>
    </div>
  );
}

function badgeVariant(tone: ProviderHealthTone) {
  if (tone === "success") return "success";
  if (tone === "warn") return "warn";
  if (tone === "danger") return "danger";
  return undefined;
}

function shortHealthDetail(health: ProviderAccountSummary["health"]) {
  if (!health) return "no checks yet";
  if (health.cooldownUntil) return `until ${formatDateTime(health.cooldownUntil)}`;
  if (health.lastErrorType) return health.lastErrorType;
  if (health.lastSuccessAt) return `success ${formatDateTime(health.lastSuccessAt)}`;
  return "no recent failures";
}

function modelDetail(model: ProviderModelHealth) {
  const healthDetail = modelHealthDetail(model);
  const bedrockDetail = bedrockHealthMetadataSummary(model.metadata);
  return [healthDetail, bedrockDetail].filter(Boolean).join(" · ");
}

function modelHealthDetail(model: ProviderModelHealth) {
  if (model.lockoutUntil) return `lockout until ${formatDateTime(model.lockoutUntil)}`;
  if (model.lastErrorType) return lastErrorLabel(model.lastErrorType, model.lastErrorAt);
  if (model.lastSuccessAt) return `success ${formatDateTime(model.lastSuccessAt)}`;
  return "no recent failures";
}

function lastErrorLabel(errorType?: string | null, errorAt?: string | null) {
  if (!errorType) return "none";
  if (!errorAt) return errorType;
  return `${errorType} at ${formatDateTime(errorAt)}`;
}

function healthTitle(account: ProviderAccountSummary) {
  const health = account.health;
  if (!health) return `${account.name}: no health data`;
  const parts = [
    providerHealthLabel(health),
    health.lastErrorType,
    health.cooldownUntil ? `cooldown until ${health.cooldownUntil}` : null
  ].filter(Boolean);
  return `${account.name}: ${parts.join(" · ")}`;
}
