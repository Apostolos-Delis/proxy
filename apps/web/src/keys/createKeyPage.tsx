import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  createApiKey,
  fetchRoutingConfigs,
  isAssignableConfig,
  isDefaultConfig,
  type CreateApiKeyInput
} from "../routing/data";
import {
  assignApiKeyProviderAccount,
  fetchProviderAccounts,
  type ProviderName
} from "../providers/data";
import { PageState, PageTitle } from "../ui";
import { ConfigureStep } from "./configureStep";
import { ReviewStep } from "./reviewStep";
import { RoutingStep } from "./routingStep";
import { StepRail } from "./stepRail";
import { VerifyStep } from "./verifyStep";
import {
  initialDraft,
  nextStepId,
  prevStepId,
  stepBlockerMessage,
  type CreatedKeyResult,
  type CreateKeyDraft
} from "./wizard";

export function CreateApiKeyPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<CreateKeyDraft>(initialDraft);
  const leaveApprovedRef = useRef(false);
  const [configsQuery, providerAccountsQuery] = useQueries({
    queries: [
      { queryKey: ["routing-configs"], queryFn: fetchRoutingConfigs },
      { queryKey: ["provider-accounts"], queryFn: fetchProviderAccounts }
    ]
  });

  const createMutation = useMutation({
    mutationFn: async (input: { create: CreateApiKeyInput; bindings: [ProviderName, string][] }) => {
      const result = await createApiKey(input.create);
      const apiKeyId = result.apiKey?.id ?? null;
      const bindingFailures: string[] = [];
      // The secret is shown exactly once, so a failed binding must not fail
      // the mutation — surface it on the verify step instead.
      if (apiKeyId) {
        for (const [provider, providerAccountId] of input.bindings) {
          try {
            await assignApiKeyProviderAccount(apiKeyId, provider, providerAccountId);
          } catch (error) {
            bindingFailures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      return {
        apiKeyId,
        keyName: result.apiKey?.name ?? input.create.name,
        secret: result.secret,
        bindingFailures
      } satisfies CreatedKeyResult;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      queryClient.invalidateQueries({ queryKey: ["routing-configs"] });
      queryClient.invalidateQueries({ queryKey: ["provider-accounts"] });
    },
    onSuccess: () => setDraft((value) => ({ ...value, stepId: "verify" }))
  });
  const created = createMutation.data ?? null;
  // The ref is consulted inside the callbacks (not at render time) so the
  // Done button can approve leaving and navigate within the same tick.
  const hasSensitiveOutput = () => Boolean(created) && !leaveApprovedRef.current;

  // Tab close/refresh still gets the browser's built-in prompt — custom UI
  // isn't allowed there — but in-app navigation pauses on our own dialog.
  const leaveBlocker = useBlocker({
    shouldBlockFn: hasSensitiveOutput,
    disabled: !created,
    enableBeforeUnload: hasSensitiveOutput,
    withResolver: true
  });

  if (configsQuery.isLoading || providerAccountsQuery.isLoading) {
    return <PageState title="Create API key" label="Loading routing configs" />;
  }
  const loadError = configsQuery.error ?? providerAccountsQuery.error;
  if (loadError) return <PageState title="Create API key" label={loadError.message} />;

  const assignable = (configsQuery.data ?? []).filter(isAssignableConfig);
  const defaultConfig = assignable.find(isDefaultConfig) ?? null;
  const configs = assignable.filter((config) => !isDefaultConfig(config));
  const providerAccounts = providerAccountsQuery.data ?? [];
  const blocker = stepBlockerMessage(draft);

  const goNext = () => {
    const next = nextStepId(draft.stepId);
    if (next) setDraft((value) => ({ ...value, stepId: next }));
  };
  const goBack = () => {
    const previous = prevStepId(draft.stepId);
    if (previous) setDraft((value) => ({ ...value, stepId: previous }));
  };
  const submit = () => {
    createMutation.mutate({
      create: {
        name: draft.name.trim(),
        scopes: draft.scopes,
        routingConfigId: draft.routingConfigId
      },
      bindings: Object.entries(draft.providerBindings).filter(
        (entry): entry is [ProviderName, string] => Boolean(entry[1])
      )
    });
  };
  const finish = () => {
    leaveApprovedRef.current = true;
    navigate({ to: "/api-keys" });
  };

  return (
    <div className="page page-enter key-wizard-page">
      <PageTitle
        title="Create API key"
        subtitle="Configure the key, point it at a routing config, then copy the secret and verify traffic."
        actions={<Link to="/api-keys" className="btn"><ArrowLeft />All keys</Link>}
      />
      <div className="key-wizard">
        <StepRail
          draft={draft}
          created={Boolean(created)}
          onVisit={(stepId) => setDraft((value) => ({ ...value, stepId }))}
        />
        <div className="wizard-panels">
          {draft.stepId === "configure" ? <ConfigureStep draft={draft} onChange={setDraft} /> : null}
          {draft.stepId === "routing" ? (
            <RoutingStep
              draft={draft}
              configs={configs}
              defaultConfig={defaultConfig}
              providerAccounts={providerAccounts}
              onChange={setDraft}
            />
          ) : null}
          {draft.stepId === "create" ? (
            <ReviewStep draft={draft} configs={configs} defaultConfig={defaultConfig} providerAccounts={providerAccounts} />
          ) : null}
          {draft.stepId === "verify" && created ? <VerifyStep created={created} /> : null}
          <WizardActions
            draft={draft}
            created={Boolean(created)}
            pending={createMutation.isPending}
            blocker={blocker}
            error={createMutation.error?.message}
            onBack={goBack}
            onNext={goNext}
            onCreate={submit}
            onFinish={finish}
          />
        </div>
      </div>
      {leaveBlocker.status === "blocked" ? (
        <LeaveConfirmDialog onStay={leaveBlocker.reset} onLeave={leaveBlocker.proceed} />
      ) : null}
    </div>
  );
}

// Portals into .app for the same reason as Drawer: the .page-enter transform
// would otherwise trap position: fixed.
function LeaveConfirmDialog({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  return createPortal(
    <>
      <div className="scrim" onClick={onStay} />
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-label="Leave without saving the key secret"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onStay();
        }}
      >
        <p>The key secret is only shown once. Leave anyway?</p>
        <div className="confirm-dialog-actions">
          <button className="btn" type="button" autoFocus onClick={onStay}>Stay</button>
          <button className="btn btn-danger" type="button" onClick={onLeave}>Leave</button>
        </div>
      </div>
    </>,
    document.querySelector(".app") ?? document.body
  );
}

function WizardActions({ draft, created, pending, blocker, error, onBack, onNext, onCreate, onFinish }: {
  draft: CreateKeyDraft;
  created: boolean;
  pending: boolean;
  blocker: string | null;
  error?: string;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
  onFinish: () => void;
}) {
  const showBack = draft.stepId !== "configure" && !created;
  return (
    <div className="wizard-actions">
      <div className="wizard-actions-status">
        {blocker ? <span className="wizard-blocker">{blocker}</span> : null}
        {error ? <span className="action-error">{error}</span> : null}
      </div>
      {showBack ? <button className="btn" type="button" disabled={pending} onClick={onBack}>Back</button> : null}
      {primaryAction(draft, created, pending, blocker, onNext, onCreate, onFinish)}
    </div>
  );
}

function primaryAction(
  draft: CreateKeyDraft,
  created: boolean,
  pending: boolean,
  blocker: string | null,
  onNext: () => void,
  onCreate: () => void,
  onFinish: () => void
) {
  if (draft.stepId === "verify" && created) {
    return <button className="btn btn-primary" type="button" onClick={onFinish}>Done</button>;
  }
  if (draft.stepId === "create") {
    return (
      <button className="btn btn-primary" type="button" disabled={pending} onClick={onCreate}>
        {pending ? "Creating…" : "Create key"}
      </button>
    );
  }
  return (
    <button className="btn btn-primary" type="button" disabled={Boolean(blocker)} onClick={onNext}>
      Next
    </button>
  );
}
