import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { JsonEditor } from "../jsonView";
import { Modal } from "../modal";
import { MenuSelect } from "../table/MenuSelect";
import { FormField as Field } from "../ui";
import {
  createProvider,
  updateProvider,
  type ProviderInput,
  type ProviderRegistrySummary
} from "./data";

type FormState = {
  slug: string;
  displayName: string;
  baseUrl: string;
  authStyle: string;
  endpointsJson: string;
  defaultHeadersJson: string;
  forwardHarnessHeaders: boolean;
  enabled: boolean;
};

export type ProviderFormMode =
  | { kind: "create" }
  | { kind: "edit"; provider: ProviderRegistrySummary };

const AUTH_STYLE_OPTIONS = [
  { value: "bearer", label: "Bearer" },
  { value: "x-api-key", label: "x-api-key" },
  { value: "none", label: "None" }
];

const emptyForm: FormState = {
  slug: "",
  displayName: "",
  baseUrl: "",
  authStyle: "bearer",
  endpointsJson: JSON.stringify([{ dialect: "openai-chat", path: "/chat/completions" }], null, 2),
  defaultHeadersJson: "{}",
  forwardHarnessHeaders: false,
  enabled: true
};

export function ProviderFormModal({ mode, onClose, onSaved }: {
  mode: ProviderFormMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => mode.kind === "edit" ? formFromProvider(mode.provider) : emptyForm);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: ProviderInput) => {
      if (mode.kind === "create") return createProvider(input);
      return updateProvider({ ...input, providerId: mode.provider.id });
    },
    onSuccess: onSaved
  });
  const requestClose = () => {
    if (!mutation.isPending) onClose();
  };

  return (
    <Modal
      label={mode.kind === "create" ? "Add provider" : `Edit ${mode.provider.displayName}`}
      title={mode.kind === "create" ? "Add provider" : mode.provider.displayName}
      subtitle={mode.kind === "edit" ? <span className="mono">{mode.provider.slug}</span> : undefined}
      onClose={requestClose}
    >
      <form className="modal-form provider-form" onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseForm(form, mode);
        setFieldError(parsed.error);
        if (!parsed.error) mutation.mutate(parsed.input);
      }}>
        <div className="routing-create-grid">
          {mode.kind === "create" ? (
            <Field label="Slug">
              <input value={form.slug} onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))} placeholder="acme-vllm" autoComplete="off" />
            </Field>
          ) : null}
          <Field label="Display name">
            <input value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="Acme vLLM" autoComplete="off" />
          </Field>
          <Field label="Base URL">
            <input value={form.baseUrl} onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://provider.example/v1" autoComplete="off" spellCheck={false} />
          </Field>
          <div className="routing-create-field">
            <span>Auth style</span>
            <MenuSelect
              ariaLabel="Auth style"
              value={form.authStyle}
              options={AUTH_STYLE_OPTIONS}
              onChange={(authStyle) => setForm((current) => ({ ...current, authStyle }))}
            />
          </div>
        </div>
        <JsonField label="Endpoints" value={form.endpointsJson} onChange={(endpointsJson) => setForm((current) => ({ ...current, endpointsJson }))} />
        <JsonField label="Default headers" value={form.defaultHeadersJson} onChange={(defaultHeadersJson) => setForm((current) => ({ ...current, defaultHeadersJson }))} />
        <div className="provider-form-switches">
          <label className="setting-toggle">
            <span>Forward harness headers</span>
            <input type="checkbox" role="switch" checked={form.forwardHarnessHeaders} onChange={(event) => setForm((current) => ({ ...current, forwardHarnessHeaders: event.target.checked }))} />
          </label>
          <label className="setting-toggle">
            <span>Enabled</span>
            <input type="checkbox" role="switch" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />
          </label>
        </div>
        {fieldError ? <div className="action-error">{fieldError}</div> : null}
        {mutation.error ? <div className="action-error">{mutation.error.message}</div> : null}
        <div className="modal-footer">
          <button className="btn btn-primary" type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Saving" : "Save provider"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function JsonField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="routing-create-field provider-json-field">
      <span>{label}</span>
      <JsonEditor value={value} onChange={onChange} />
    </div>
  );
}

function parseForm(form: FormState, mode: ProviderFormMode): { input: ProviderInput; error: null } | { input: ProviderInput; error: string } {
  const slug = mode.kind === "create" ? form.slug.trim() : mode.provider.slug;
  const endpoints = parseEndpoints(form.endpointsJson);
  if (typeof endpoints === "string") return { input: emptyProviderInput(slug), error: endpoints };
  const defaultHeaders = parseHeaders(form.defaultHeadersJson);
  if (typeof defaultHeaders === "string") return { input: emptyProviderInput(slug), error: defaultHeaders };
  return {
    input: {
      slug,
      displayName: form.displayName.trim(),
      baseUrl: form.baseUrl.trim(),
      authStyle: form.authStyle,
      endpoints,
      defaultHeaders,
      forwardHarnessHeaders: form.forwardHarnessHeaders,
      enabled: form.enabled
    },
    error: null
  };
}

function parseEndpoints(text: string) {
  const value = parseJson(text, "Endpoints");
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "Endpoints must be a JSON array.";
  return value.map((item) => ({
    dialect: recordString(item, "dialect"),
    path: recordString(item, "path")
  }));
}

function parseHeaders(text: string) {
  const value = parseJson(text, "Default headers");
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Default headers must be a JSON object.";
  return Object.fromEntries(
    Object.entries(value).map(([key, headerValue]) => [key, typeof headerValue === "string" ? headerValue : String(headerValue)])
  );
}

function parseJson(text: string, label: string) {
  try {
    return JSON.parse(text);
  } catch {
    return `${label} must be valid JSON.`;
  }
}

function recordString(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

function formFromProvider(provider: ProviderRegistrySummary): FormState {
  return {
    slug: provider.slug,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    authStyle: provider.authStyle,
    endpointsJson: JSON.stringify(provider.endpoints, null, 2),
    defaultHeadersJson: JSON.stringify(headerRecord(provider.defaultHeaders), null, 2),
    forwardHarnessHeaders: provider.forwardHarnessHeaders,
    enabled: provider.enabled
  };
}

function headerRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, string>;
}

function emptyProviderInput(slug: string): ProviderInput {
  return {
    slug,
    displayName: "",
    baseUrl: "",
    authStyle: "bearer",
    endpoints: [],
    defaultHeaders: {},
    forwardHarnessHeaders: false,
    enabled: true
  };
}
