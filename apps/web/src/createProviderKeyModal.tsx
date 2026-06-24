import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  cancelProviderCredentialOAuth,
  createProviderCredential,
  createProviderCredentialFromLocalAuth,
  fetchProviderCredentialOAuthStatus,
  fetchProviderRegistry,
  fetchSubscriptionOAuthEnabled,
  startProviderCredentialOAuth,
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
  initialProviderCredentialDraft,
  nextStepId,
  prevStepId,
  stepBlockerMessage,
  type CreateProviderCredentialDraft,
  type CreateProviderCredentialMode
} from "./providers/createCredentialWizard";
import {
  CreatedCredentialStep,
  oauthBlockerMessage,
  WizardActions,
  type CreatedProviderCredential
} from "./providers/createCredentialWizardFooter";

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
  const oauthCompletionNotified = useRef<string | null>(null);
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
      if (!account) throw new Error("The server did not confirm the new credential — check the model providers page before retrying.");
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
  const oauthStartMutation = useMutation({
    mutationFn: startProviderCredentialOAuth,
    onSuccess: (result) => {
      window.open(result.verificationUrl, "_blank", "noopener,noreferrer");
    }
  });
  const oauthStatusQuery = useQuery({
    queryKey: ["provider-credential-oauth-status", oauthStartMutation.data?.loginId],
    enabled: Boolean(oauthStartMutation.data?.loginId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "completed" || status === "failed" ? false : 1500;
    },
    queryFn: async () => {
      const loginId = oauthStartMutation.data?.loginId;
      if (!loginId) return null;
      const status = await fetchProviderCredentialOAuthStatus(loginId);
      if (!status) {
        const providerLabel = draft.provider === "anthropic" ? "Claude" : "OpenAI";
        return {
          loginId,
          status: "failed",
          providerAccountId: null,
          error: `${providerLabel} sign-in session expired. Start again.`
        };
      }
      if (
        status?.status === "completed" &&
        status.providerAccountId &&
        oauthCompletionNotified.current !== loginId
      ) {
        oauthCompletionNotified.current = loginId;
        queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
        queryClient.invalidateQueries({ queryKey: ["api-keys"] });
        onCreated?.({ id: status.providerAccountId, provider: draft.provider });
      }
      return status;
    }
  });
  const oauthWaiting = Boolean(
    oauthStartMutation.data?.loginId &&
    oauthStatusQuery.data?.status !== "completed" &&
    oauthStatusQuery.data?.status !== "failed"
  );
  const oauthCancelMutation = useMutation({
    mutationFn: cancelProviderCredentialOAuth,
    onSuccess: (status) => {
      if (status) {
        queryClient.setQueryData(
          ["provider-credential-oauth-status", status.loginId],
          status
        );
      }
      onClose();
    }
  });
  const requestClose = () => {
    if (createMutation.isPending || oauthStartMutation.isPending || oauthCancelMutation.isPending) return;
    const loginId = oauthStartMutation.data?.loginId;
    if (oauthWaiting && loginId) {
      oauthCancelMutation.mutate(loginId);
      return;
    }
    onClose();
  };
  const oauthCreated = oauthStatusQuery.data?.status === "completed" && oauthStatusQuery.data.providerAccountId
    ? {
      id: oauthStatusQuery.data.providerAccountId,
      provider: draft.provider,
      name: draft.name.trim(),
      mode: draft.mode
    } satisfies CreatedProviderCredential
    : null;
  const created = createMutation.data ?? oauthCreated;
  const visibleDraft = created ? { ...draft, stepId: "bind" as const } : draft;
  const blocker = created ? null : stepBlockerMessage(draft, subscriptionAuthEnabled) ??
    oauthBlockerMessage(draft, oauthStartMutation, oauthStatusQuery);
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
  const updateDraft = (next: CreateProviderCredentialDraft) => {
    if (oauthWaiting) return;
    if (
      next.mode !== draft.mode ||
      next.source !== draft.source ||
      next.name !== draft.name ||
      next.baseUrl !== draft.baseUrl
    ) {
      oauthStartMutation.reset();
      oauthCompletionNotified.current = null;
    }
    setDraft(next);
  };
  const startOAuth = () => {
    if (oauthWaiting) return;
    const nextError = credentialBlockerMessage(draft, subscriptionAuthEnabled);
    setFieldError(nextError);
    if (nextError) return;
    oauthStartMutation.mutate({
      provider: draft.provider,
      name: draft.name.trim()
    });
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
      label="Add provider credential"
      title="Add provider credential"
      subtitle="Create the upstream credential first, then bind it to a Proxy API key that should use it."
      onClose={requestClose}
    >
      <div className="provider-key-wizard">
        <ProviderCredentialStepRail
          draft={visibleDraft}
          created={Boolean(created)}
          onVisit={(stepId) => {
            if (oauthWaiting) return;
            setFieldError(null);
            setDraft((current) => ({ ...current, stepId }));
          }}
        />
        <div className="wizard-panels">
          {visibleDraft.stepId === "type" ? (
            <CredentialTypeStep
              draft={draft}
              subscriptionAuthEnabled={subscriptionAuthEnabled}
              onChange={updateDraft}
            />
          ) : null}
          {visibleDraft.stepId === "credentials" ? (
            <CredentialDetailsStep
              draft={draft}
              providerOptions={providerOptions}
              oauth={{
                start: oauthStartMutation.data ?? null,
                status: oauthStatusQuery.data ?? null,
                pending: oauthStartMutation.isPending,
                checking: oauthStatusQuery.isFetching,
                error: oauthStartMutation.error?.message,
                locked: oauthWaiting,
                onStart: startOAuth
              }}
              onChange={updateDraft}
            />
          ) : null}
          {visibleDraft.stepId === "review" ? <CredentialReviewStep draft={draft} /> : null}
          {visibleDraft.stepId === "bind" && created ? (
            <CreatedCredentialStep created={created} embedded={Boolean(onCreated)} onClose={requestClose} />
          ) : null}
          <WizardActions
            draft={visibleDraft}
            created={Boolean(created)}
            pending={createMutation.isPending || oauthStartMutation.isPending || oauthCancelMutation.isPending || oauthWaiting}
            blocker={blocker}
            fieldError={fieldError}
            mutationError={createMutation.error?.message ?? oauthCancelMutation.error?.message}
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
