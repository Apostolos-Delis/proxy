import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, TerminalSquare } from "lucide-react";
import { useState, type ReactNode } from "react";

import { createApiKey, type CreatedApiKey, type RoutingConfigSummary } from "./api";
import { Badge, GlassCard } from "./ui";

export const apiKeyScopeOptions = [
  {
    value: "proxy",
    description: "Send model traffic through the /v1 proxy endpoints."
  },
  {
    value: "harness_identity",
    description: "Trust the user and session identity headers reported by the coding harness."
  },
  {
    value: "admin",
    description: "Reserved for administrative automation."
  }
];

type CreateForm = {
  name: string;
  scopes: string[];
  routingConfigId: string;
};

const emptyForm: CreateForm = {
  name: "",
  scopes: ["proxy", "harness_identity"],
  routingConfigId: ""
};

export function CreateApiKeyPanel({ configs, onCreated, onShowSetup }: {
  configs: RoutingConfigSummary[];
  onCreated: (created: CreatedApiKey) => void;
  onShowSetup: () => void;
}) {
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [nameError, setNameError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedApiKey | null>(null);
  const queryClient = useQueryClient();
  const createMutation = useMutation({
    mutationFn: () => createApiKey({
      name: form.name.trim(),
      scopes: form.scopes,
      routingConfigId: form.routingConfigId || null
    }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
      setResult(data);
      onCreated(data);
      setForm(emptyForm);
    }
  });

  return (
    <GlassCard className="routing-config-create">
      <form onSubmit={(event) => {
        event.preventDefault();
        const nextError = form.name.trim() ? null : "Name is required.";
        setNameError(nextError);
        if (!nextError) createMutation.mutate();
      }}>
        <div className="card-head routing-create-head">
          <div>
            <div className="card-title"><KeyRound />Create API key</div>
            <div className="faint">The key secret is generated once and stored as a hash — copy it right away.</div>
          </div>
          <button className="btn btn-primary" type="submit" disabled={createMutation.isPending || form.scopes.length === 0}>
            {createMutation.isPending ? "Creating" : "Create key"}
          </button>
        </div>
        <div className="routing-create-grid key-create-grid">
          <Field label="Name" error={nameError ?? undefined}>
            <input
              value={form.name}
              onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))}
              placeholder="CI harness key"
              autoComplete="off"
            />
          </Field>
          <Field label="Routing config">
            <select
              value={form.routingConfigId}
              onChange={(event) => setForm((value) => ({ ...value, routingConfigId: event.target.value }))}
            >
              <option value="">Organization default</option>
              {configs.map((config) => (
                <option key={config.id} value={config.id}>{config.name}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="scope-options">
          <span className="scope-options-label">Scopes</span>
          {apiKeyScopeOptions.map((scope) => (
            <label key={scope.value} className="scope-option">
              <input
                type="checkbox"
                checked={form.scopes.includes(scope.value)}
                onChange={(event) => setForm((value) => ({
                  ...value,
                  scopes: event.target.checked
                    ? [...value.scopes, scope.value]
                    : value.scopes.filter((item) => item !== scope.value)
                }))}
              />
              <span className="code-pill">{scope.value}</span>
              <span className="faint">{scope.description}</span>
            </label>
          ))}
          {form.scopes.length === 0 ? <div className="action-error">Pick at least one scope.</div> : null}
        </div>
        {createMutation.error ? <div className="action-error">{createMutation.error.message}</div> : null}
        {result ? <SecretResult result={result} onShowSetup={onShowSetup} /> : null}
      </form>
    </GlassCard>
  );
}

function SecretResult({ result, onShowSetup }: { result: CreatedApiKey; onShowSetup: () => void }) {
  return (
    <div className="invite-result">
      <div className="row gap-8">
        <Badge variant="success" dot>{result.apiKey ? `${result.apiKey.name} created` : "Key created"}</Badge>
        <span className="faint">Copy the secret now — it is never shown again.</span>
      </div>
      <CopySecret secret={result.secret} />
      <div>
        <button className="btn btn-sm" type="button" onClick={onShowSetup}>
          <TerminalSquare />
          Set up Claude Code / Codex with this key
        </button>
      </div>
    </div>
  );
}

function CopySecret({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row gap-8 invite-link-row">
      <span className="mono invite-link">{secret}</span>
      <button
        className="btn btn-sm"
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(secret);
          setCopied(true);
        }}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy key"}
      </button>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="routing-create-field">
      <span>{label}</span>
      {children}
      {error ? <small>{error}</small> : null}
    </label>
  );
}
