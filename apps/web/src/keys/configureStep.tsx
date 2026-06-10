import { KeyRound } from "lucide-react";

import { GlassCard } from "../ui";
import { apiKeyScopeOptions } from "./scopeOptions";
import type { CreateKeyDraft } from "./wizard";

export function ConfigureStep({ draft, onChange }: {
  draft: CreateKeyDraft;
  onChange: (draft: CreateKeyDraft) => void;
}) {
  return (
    <GlassCard>
      <div className="card-head">
        <div>
          <div className="card-title"><KeyRound />Name & scopes</div>
          <div className="faint">Name the key after the workload that will hold it, then grant only the scopes it needs.</div>
        </div>
      </div>
      <div className="wizard-step-body">
        <label className="routing-create-field wizard-name-field">
          <span>Name</span>
          <input
            value={draft.name}
            placeholder="CI harness key"
            autoComplete="off"
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <div className="scope-options">
          <span className="scope-options-label">Scopes</span>
          {apiKeyScopeOptions.map((scope) => (
            <label key={scope.value} className="scope-option">
              <input
                type="checkbox"
                checked={draft.scopes.includes(scope.value)}
                onChange={(event) => onChange({
                  ...draft,
                  scopes: event.target.checked
                    ? [...draft.scopes, scope.value]
                    : draft.scopes.filter((item) => item !== scope.value)
                })}
              />
              <span className="code-pill">{scope.value}</span>
              <span className="faint">{scope.description}</span>
            </label>
          ))}
        </div>
      </div>
    </GlassCard>
  );
}
