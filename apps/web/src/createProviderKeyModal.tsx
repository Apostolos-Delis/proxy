import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  createProviderCredential,
  fetchSubscriptionOAuthEnabled,
  type CreateProviderCredentialInput,
  type ProviderName
} from "./providers/data";
import type { ProviderAccountAuthType } from "./gql/graphql";
import { Modal } from "./modal";
import { PROVIDER_OPTIONS } from "./providers";
import { MenuSelect } from "./table/MenuSelect";
import { Badge, FormField as Field } from "./ui";

type CreateForm = {
  provider: ProviderName;
  name: string;
  authType: ProviderAccountAuthType;
  apiKey: string;
};

const emptyForm: CreateForm = {
  provider: "anthropic",
  name: "",
  authType: "api_key",
  apiKey: ""
};

const AUTH_TYPE_OPTIONS: { value: ProviderAccountAuthType; label: string }[] = [
  { value: "api_key", label: "API key" },
  { value: "oauth", label: "Claude subscription (Pro/Max)" }
];

// Must stay in sync with CLAUDE_SUBSCRIPTION_TOKEN_PREFIX in
// packages/schema/src/index.ts — the server enforces the same prefix.
const SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat01-";

export function CreateProviderKeyModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated?: (account: { id: string; provider: ProviderName }) => void;
}) {
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const subscriptionAuthQuery = useQuery({
    queryKey: ["subscription-oauth-enabled"],
    queryFn: fetchSubscriptionOAuthEnabled
  });
  const subscriptionAuthEnabled = subscriptionAuthQuery.data === true;
  const isSubscription = form.authType === "oauth";
  const createMutation = useMutation({
    mutationFn: async (input: CreateProviderCredentialInput) => {
      const account = await createProviderCredential(input);
      // Nullable per codegen; closing as if it succeeded would silently skip
      // the wizard's auto-bind.
      if (!account) throw new Error("The server did not confirm the new key — check the provider keys list before retrying.");
      return account;
    },
    onSuccess: (account, variables) => {
      queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      onCreated?.({ id: account.id, provider: variables.provider });
      onClose();
    }
  });
  // Closing mid-flight would unmount the mutation and drop the cache
  // invalidation and onCreated callback.
  const requestClose = () => {
    if (!createMutation.isPending) onClose();
  };

  return (
    <Modal
      label="Add provider key"
      title="Add provider key"
      subtitle="Stored encrypted at rest and only used to forward traffic from keys you bind it to."
      onClose={requestClose}
    >
      <form className="modal-form" onSubmit={(event) => {
        event.preventDefault();
        const nextError = validate(form, subscriptionAuthEnabled);
        setFieldError(nextError);
        if (!nextError) {
          createMutation.mutate({
            provider: form.provider,
            name: form.name.trim(),
            authType: form.authType,
            apiKey: form.apiKey.trim()
          });
        }
      }}>
        <div className="routing-create-grid key-create-grid">
          {/* The select fields use a <div>, not FormField's <label>: clicking
              the popover backdrop (a label descendant) would re-trigger the
              select button and reopen the menu. */}
          {subscriptionAuthEnabled ? (
            <div className="routing-create-field">
              <span>Auth type</span>
              <MenuSelect
                ariaLabel="Auth type"
                value={form.authType}
                options={AUTH_TYPE_OPTIONS}
                onChange={(value) => setForm((current) => ({
                  ...current,
                  authType: value as ProviderAccountAuthType,
                  // Subscription tokens are Anthropic-only in V1.
                  provider: value === "oauth" ? "anthropic" : current.provider
                }))}
              />
            </div>
          ) : null}
          <div className="routing-create-field">
            <span>Provider</span>
            <MenuSelect
              ariaLabel="Provider"
              value={form.provider}
              options={isSubscription ? PROVIDER_OPTIONS.filter((option) => option.value === "anthropic") : PROVIDER_OPTIONS}
              onChange={(value) => setForm((current) => ({ ...current, provider: value as ProviderName }))}
            />
          </div>
          <Field label="Label">
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder={isSubscription ? "My Claude Max subscription" : "Acme Corp Anthropic key"}
              autoComplete="off"
            />
          </Field>
        </div>
        <Field label={isSubscription ? "Subscription token" : "API key"}>
          <input
            value={form.apiKey}
            onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
            placeholder={isSubscription ? `${SUBSCRIPTION_TOKEN_PREFIX}...` : "sk-ant-..."}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        {isSubscription ? (
          <div className="subscription-token-note">
            <div className="faint">
              Run <span className="mono">claude setup-token</span> on a Pro/Max account and paste the token it prints.
            </div>
            <Badge variant="warn" dot>
              Uses your personal Claude subscription against Anthropic&apos;s terms — enforcement lands on your own account. Internal use only.
            </Badge>
          </div>
        ) : null}
        {fieldError ? <div className="action-error">{fieldError}</div> : null}
        {createMutation.error ? <div className="action-error">{createMutation.error.message}</div> : null}
        <div className="modal-footer">
          <button className="btn btn-primary" type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Saving" : "Save key"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function validate(form: CreateForm, subscriptionAuthEnabled: boolean) {
  if (!form.name.trim()) return "Label is required.";
  if (!form.apiKey.trim()) return form.authType === "oauth" ? "Subscription token is required." : "API key is required.";
  if (form.authType === "oauth" && !subscriptionAuthEnabled) {
    return "Subscription auth has been disabled for this proxy.";
  }
  if (form.authType === "oauth" && !form.apiKey.trim().startsWith(SUBSCRIPTION_TOKEN_PREFIX)) {
    return `Subscription tokens from \`claude setup-token\` start with ${SUBSCRIPTION_TOKEN_PREFIX}`;
  }
  return null;
}
