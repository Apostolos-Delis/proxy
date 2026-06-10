import { Check } from "lucide-react";

import { canVisitStep, createKeySteps, stepRailState, type CreateKeyDraft, type CreateKeyStepId } from "./wizard";

export function StepRail({ draft, created, onVisit }: {
  draft: CreateKeyDraft;
  created: boolean;
  onVisit: (stepId: CreateKeyStepId) => void;
}) {
  return (
    <ol className="wizard-rail">
      {createKeySteps.map((step, index) => {
        const state = stepRailState(step.id, draft.stepId, created);
        const visitable = canVisitStep(step.id, draft, created);
        return (
          <li key={step.id}>
            <button
              type="button"
              className="wizard-rail-step"
              data-state={state}
              disabled={!visitable}
              aria-current={state === "current" ? "step" : undefined}
              onClick={() => onVisit(step.id)}
            >
              <span className="wizard-rail-marker">{state === "complete" ? <Check /> : index + 1}</span>
              <span className="wizard-rail-label">{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
