import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  createProviderCredential,
  createProviderCredentialFromLocalAuth,
  fetchProviderRegistry,
  fetchSubscriptionOAuthEnabled,
  type CreateProviderCredentialInput,
  type ProviderName
} from "./providers/data";
import { Modal } from "./modal";
import { PROVIDER_OPTIONS, providerOptionsFromRegistry } from "./providers";
import {
  CredentialDetailsStep,
  CredentialReviewStep,
  CredentialTypeStep,
  ProviderCredentialStepRail
} from "./providers/createCredentialSteps";
import {
  authTypeForMode,
  credentialBlockerMessage,
  credentialModeLabel,
  initialProviderCredentialDraft,
  nextStepId,
  prevStepId,
  stepBlockerMessage,
  type CreateProviderCredentialDraft,
  type CreateProviderCredentialMode
} from "./providers/createCredentialWizard";
import { Badge, GlassCard } from "./ui";

type CreatedProviderCredential = {
  id: string;
  provider: ProviderName;
  name: string;
  mode: CreateProviderCredentialMode;
};

type CreateProviderCredentialRequest = {
  mode: CreateProviderCredentialMode;
  source: CreateProviderCredentialDraft["source"];
} & CreateProviderCredentialInput;

export function CreateProviderKeyModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated?: (account: { id: string; provider: ProviderName }) => void;
}) {
  const [draft, setDraft] = useState<CreateProviderCredentialDraft>(initialProviderCredentialDraft);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: subscriptionAuthQueryData } = useQuery({
    queryKey: ["subscription-oauth-enabled"],
    queryFn: fetchSubscriptionOAuthEnabled
  });
  const { data: providerRegistryQueryData } = useQuery({
    queryKey: ["provider-registry"],
    queryFn: fetchProviderRegistry
  });
  const providerOptions = providerRegistryQueryData
    ? providerOptionsFromRegistry(providerRegistryQueryData)
    : PROVIDER_OPTIONS;
  const subscriptionAuthEnabled = subscriptionAuthQueryData === true;

  const createMutation = useMutation({
    mutationFn: async (input: CreateProviderCredentialRequest) => {
      const { mode, source, ...credentialInput } = input;
      const account = source === "local_auth" && mode !== "api_key"
        ? await createProviderCredentialFromLocalAuth({
          provider: credentialInput.provider,
          name: credentialInput.name,
          baseUrl: credentialInput.baseUrl
        })
        : await createProviderCredential(credentialInput);
      if (!account) throw new Error("The server did not confirm the new key — check the provider keys list before retrying.");
      return {
        id: account.id,
        provider: credentialInput.provider,
        name: credentialInput.name,
        mode
      } satisfies CreatedProviderCredential;
    },
    onSuccess: (account) => {
      queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      onCreated?.({ id: account.id, provider: account.provider });
      setDraft((current) => ({ ...current, stepId: "bind" }));
      setFieldError(null);
    }
  });

  const requestClose = () => {
    if (!createMutation.isPending) onClose();
  };
  const created = createMutation.data ?? null;
  const blocker = created ? null : stepBlockerMessage(draft, subscriptionAuthEnabled);
  const goNext = () => {
    const next = nextStepId(draft.stepId);
    if (next) {
      setFieldError(null);
      setDraft((current) => ({ ...current, stepId: next }));
    }
  };
  const goBack = () => {
    const previous = prevStepId(draft.stepId);
    if (previous) {
      setFieldError(null);
      setDraft((current) => ({ ...current, stepId: previous }));
    }
  };
  const submit = () => {
    const nextError = credentialBlockerMessage(draft, subscriptionAuthEnabled);
    setFieldError(nextError);
    if (nextError) return;
    createMutation.mutate({
      provider: draft.provider,
      name: draft.name.trim(),
      authType: authTypeForMode(draft.mode),
      apiKey: draft.apiKey.trim(),
      baseUrl: draft.baseUrl.trim() || undefined,
      chatgptAccountId: draft.chatgptAccountId.trim() || undefined,
      mode: draft.mode,
      source: draft.source
    });
  };

  return (
    <Modal
      className="provider-key-modal"
      label="Add provider key"
      title="Add provider key"
      subtitle="Create the upstream credential first, then bind it to a Prompt Proxy API key that should use it."
      onClose={requestClose}
    >
      <div className="provider-key-wizard">
        <ProviderCredentialStepRail
          draft={draft}
          created={Boolean(created)}
          onVisit={(stepId) => {
            setFieldError(null);
            setDraft((current) => ({ ...current, stepId }));
          }}
        />
        <div className="wizard-panels">
          {draft.stepId === "type" ? (
            <CredentialTypeStep
              draft={draft}
              subscriptionAuthEnabled={subscriptionAuthEnabled}
              onChange={setDraft}
            />
          ) : null}
          {draft.stepId === "credentials" ? (
            <CredentialDetailsStep
              draft={draft}
              providerOptions={providerOptions}
              onChange={setDraft}
            />
          ) : null}
          {draft.stepId === "review" ? <CredentialReviewStep draft={draft} /> : null}
          {draft.stepId === "bind" && created ? (
            <CreatedCredentialStep created={created} embedded={Boolean(onCreated)} onClose={requestClose} />
          ) : null}
          <WizardActions
            draft={draft}
            created={Boolean(created)}
            pending={createMutation.isPending}
            blocker={blocker}
            fieldError={fieldError}
            mutationError={createMutation.error?.message}
            onBack={goBack}
            onNext={goNext}
            onCreate={submit}
            onDone={requestClose}
          />
        </div>
      </div>
    </Modal>
  );
}

function CreatedCredentialStep({ created, embedded, onClose }: {
  created: CreatedProviderCredential;
  embedded: boolean;
  onClose: () => void;
}) {
  return (
    <GlassCard>
      <div className="invite-result">
        <div className="row gap-8">
          <Badge variant="success" dot>{created.name} saved</Badge>
          <span className="faint">{credentialModeLabel(created.mode)} credential created for <span className="mono">{created.provider}</span>.</span>
        </div>
      </div>
      {embedded ? (
        <div className="provider-credential-note">
          <Badge variant="success" dot>Selected</Badge>
          <span>This provider key is selected for the API key you are creating.</span>
        </div>
      ) : (
        <div className="provider-credential-note">
          <Badge variant="warn" dot>Bind next</Badge>
          <span>Bind it to a Prompt Proxy API key you own before traffic can use it.</span>
        </div>
      )}
      {embedded ? null : (
        <Link to="/api-keys" className="btn btn-primary provider-credential-bind-link" onClick={onClose}>
          Bind on API keys
        </Link>
      )}
    </GlassCard>
  );
}

function WizardActions({ draft, created, pending, blocker, fieldError, mutationError, onBack, onNext, onCreate, onDone }: {
  draft: CreateProviderCredentialDraft;
  created: boolean;
  pending: boolean;
  blocker: string | null;
  fieldError: string | null;
  mutationError?: string;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
  onDone: () => void;
}) {
  const showBack = draft.stepId !== "type" && !created;
  return (
    <div className="wizard-actions">
      <div className="wizard-actions-status">
        {blocker ? <span className="wizard-blocker">{blocker}</span> : null}
        {fieldError ? <span className="action-error">{fieldError}</span> : null}
        {mutationError ? <span className="action-error">{mutationError}</span> : null}
      </div>
      {showBack ? <button className="btn" type="button" disabled={pending} onClick={onBack}>Back</button> : null}
      {primaryAction(draft, created, pending, blocker, onNext, onCreate, onDone)}
    </div>
  );
}

function primaryAction(
  draft: CreateProviderCredentialDraft,
  created: boolean,
  pending: boolean,
  blocker: string | null,
  onNext: () => void,
  onCreate: () => void,
  onDone: () => void
) {
  if (draft.stepId === "bind" && created) {
    return <button className="btn btn-primary" type="button" onClick={onDone}>Done</button>;
  }
  if (draft.stepId === "review") {
    return (
      <button className="btn btn-primary" type="button" disabled={pending} onClick={onCreate}>
        {pending ? "Saving…" : "Save credential"}
      </button>
    );
  }
  return (
    <button className="btn btn-primary" type="button" disabled={Boolean(blocker)} onClick={onNext}>
      Next
    </button>
  );
}
