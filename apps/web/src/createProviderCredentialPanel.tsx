import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeySquare } from "lucide-react";
import { useState } from "react";

import { createProviderCredential, type ProviderName } from "./providers/data";
import { PROVIDER_OPTIONS } from "./providers";
import { MenuSelect } from "./table/MenuSelect";
import { FormField as Field, GlassCard } from "./ui";

type CreateForm = {
  provider: ProviderName;
  name: string;
  apiKey: string;
};

const emptyForm: CreateForm = {
  provider: "anthropic",
  name: "",
  apiKey: ""
};

export function CreateProviderCredentialPanel({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const createMutation = useMutation({
    mutationFn: () => createProviderCredential({
      provider: form.provider,
      name: form.name.trim(),
      apiKey: form.apiKey.trim()
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      setForm(emptyForm);
      onClose();
    }
  });

  return (
    <GlassCard className="routing-config-create">
      <form onSubmit={(event) => {
        event.preventDefault();
        const nextError = validate(form);
        setFieldError(nextError);
        if (!nextError) createMutation.mutate();
      }}>
        <div className="card-head routing-create-head">
          <div>
            <div className="card-title"><KeySquare />Add provider key</div>
            <div className="faint">Stored encrypted at rest and only used to forward traffic from keys you bind it to.</div>
          </div>
          <button className="btn btn-primary" type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Saving" : "Save key"}
          </button>
        </div>
        <div className="routing-create-grid key-create-grid">
          <Field label="Provider">
            <MenuSelect
              ariaLabel="Provider"
              value={form.provider}
              options={PROVIDER_OPTIONS}
              onChange={(value) => setForm((current) => ({ ...current, provider: value as ProviderName }))}
            />
          </Field>
          <Field label="Label">
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Acme Corp Anthropic key"
              autoComplete="off"
            />
          </Field>
        </div>
        <Field label="API key">
          <input
            value={form.apiKey}
            onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
            placeholder="sk-ant-..."
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        {fieldError ? <div className="action-error">{fieldError}</div> : null}
        {createMutation.error ? <div className="action-error">{createMutation.error.message}</div> : null}
      </form>
    </GlassCard>
  );
}

function validate(form: CreateForm) {
  if (!form.name.trim()) return "Label is required.";
  if (!form.apiKey.trim()) return "API key is required.";
  return null;
}
