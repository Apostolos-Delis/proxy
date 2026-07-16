import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Modal } from "../modal";
import {
  createLogicalModel,
  createModelBlocker,
  defaultRouterPolicy,
  slugify,
  type CreateLogicalModelDraft,
  type DeploymentOption,
  type RouterDefaults
} from "../modelsPageData";
import { SearchSelect } from "../table/SearchSelect";
import { FormField, Segmented } from "../ui";

export function CreateModelModal({ options, defaults, onClose }: {
  options: DeploymentOption[];
  defaults: RouterDefaults;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CreateLogicalModelDraft>(() => ({
    slug: "",
    name: "",
    description: "",
    kind: "direct",
    deploymentIds: [],
    policy: defaultRouterPolicy,
    classifierDeploymentId: defaults.classifierDeploymentId ?? ""
  }));
  const [slugEdited, setSlugEdited] = useState(false);
  const queryClient = useQueryClient();
  const createMutation = useMutation({
    mutationFn: () => createLogicalModel(draft, defaults, options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gateway-models"] });
      queryClient.invalidateQueries({ queryKey: ["gateway-access-profiles"] });
      queryClient.invalidateQueries({ queryKey: ["gateway-model-access"] });
      onClose();
    }
  });
  const blocker = createModelBlocker(draft);

  return (
    <Modal
      label="Create logical model"
      title="New logical model"
      subtitle="The slug is the model name applications request through the API."
      className="create-model-modal"
      onClose={onClose}
    >
      <div className="wizard-step-body">
        <FormField label="Name">
          <input
            value={draft.name}
            placeholder="Chat Frontier"
            autoComplete="off"
            maxLength={256}
            onChange={(event) => setDraft((value) => ({
              ...value,
              name: event.target.value,
              slug: slugEdited ? value.slug : slugify(event.target.value)
            }))}
          />
        </FormField>
        <FormField label="Slug">
          <input
            value={draft.slug}
            placeholder="chat-frontier"
            autoComplete="off"
            maxLength={128}
            onChange={(event) => {
              setSlugEdited(true);
              setDraft((value) => ({ ...value, slug: event.target.value }));
            }}
          />
        </FormField>
        <FormField label="Description">
          <input
            value={draft.description}
            placeholder="Optional"
            autoComplete="off"
            maxLength={2000}
            onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))}
          />
        </FormField>
        <div className="inline-form-field">
          <span>Resolution</span>
          <Segmented
            options={[
              { value: "direct", label: "Direct" },
              { value: "router", label: "Auto-router" }
            ]}
            value={draft.kind}
            onChange={(kind) => setDraft((value) => ({ ...value, kind, deploymentIds: [] }))}
          />
        </div>
        {draft.kind === "direct" ? (
          <div className="inline-form-field">
            <span>Deployment</span>
            <SearchSelect
              value={draft.deploymentIds[0] ?? ""}
              options={options.map((option) => ({ value: option.id, label: option.label, hint: option.hint }))}
              ariaLabel="Deployment"
              placeholder="Search deployments..."
              onChange={(deploymentId) => setDraft((value) => ({ ...value, deploymentIds: [deploymentId] }))}
            />
          </div>
        ) : (
          <RouterFields draft={draft} options={options} onChange={setDraft} />
        )}
        <div className="wizard-actions">
          <div className="wizard-actions-status">
            {blocker && (draft.name || draft.deploymentIds.length > 0) ? <span className="wizard-blocker">{blocker}</span> : null}
            {createMutation.error ? <span className="action-error">{createMutation.error.message}</span> : null}
          </div>
          <button
            className="btn btn-primary"
            type="button"
            disabled={Boolean(blocker) || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? "Creating…" : "Create model"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RouterFields({ draft, options, onChange }: {
  draft: CreateLogicalModelDraft;
  options: DeploymentOption[];
  onChange: (draft: CreateLogicalModelDraft) => void;
}) {
  const classifierOptions = options.filter((option) => option.classifierCapable);
  const toggleDeployment = (deploymentId: string, checked: boolean) => onChange({
    ...draft,
    deploymentIds: checked
      ? [...draft.deploymentIds, deploymentId]
      : draft.deploymentIds.filter((id) => id !== deploymentId)
  });
  return (
    <>
      <div className="scope-options" role="group" aria-label="Route targets">
        <span className="scope-options-label">Route targets</span>
        {options.map((option) => (
          <label key={option.id} className="scope-option">
            <input
              type="checkbox"
              checked={draft.deploymentIds.includes(option.id)}
              onChange={(event) => toggleDeployment(option.id, event.target.checked)}
            />
            <span>{option.label}</span>
            <span className="faint">{option.hint}</span>
          </label>
        ))}
      </div>
      <FormField label="Routing policy">
        <textarea
          value={draft.policy}
          rows={4}
          maxLength={20000}
          onChange={(event) => onChange({ ...draft, policy: event.target.value })}
        />
      </FormField>
      <div className="inline-form-field">
        <span>Classifier deployment</span>
        <SearchSelect
          value={draft.classifierDeploymentId}
          options={classifierOptions.map((option) => ({ value: option.id, label: option.label, hint: option.hint }))}
          ariaLabel="Classifier deployment"
          placeholder="Search deployments..."
          onChange={(classifierDeploymentId) => onChange({ ...draft, classifierDeploymentId })}
        />
      </div>
    </>
  );
}
