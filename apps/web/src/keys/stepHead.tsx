import type { ReactNode } from "react";

export function WizardStepHead({ icon, title, sub }: { icon?: ReactNode; title: string; sub: string }) {
  return (
    <div className="wizard-step-head">
      <h3 className="wizard-step-title">{icon}{title}</h3>
      <p className="wizard-step-sub">{sub}</p>
    </div>
  );
}
