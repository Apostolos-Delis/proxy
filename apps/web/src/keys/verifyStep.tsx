import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleDashed, TerminalSquare } from "lucide-react";
import { useState } from "react";

import { fetchApiKeyVerification } from "./data";
import { GlassCard } from "../ui";
import { formatDateTime } from "../format";
import { HarnessSetupGuide } from "../harnessSetupCard";
import { CopySecret } from "./copySecret";
import {
  defaultHarnessSetupSelection,
  harnessSetupOptions,
  type HarnessSetupSelection
} from "./setupSnippets";
import { WizardStepHead } from "./stepHead";
import type { CreatedKeyResult } from "./wizard";

export function VerifyStep({ created }: { created: CreatedKeyResult }) {
  const [harnesses, setHarnesses] = useState<HarnessSetupSelection>([...defaultHarnessSetupSelection]);
  return (
    <GlassCard className="key-activation-card">
      <section className="key-result-block" aria-labelledby="key-result-title">
        <div className="key-result-head">
          <span className="key-result-icon" aria-hidden="true"><CircleCheck /></span>
          <div>
            <h3 id="key-result-title">{created.keyName} is ready</h3>
            <p>Save this key now. You won&apos;t be able to reveal it again.</p>
          </div>
        </div>
        <CopySecret secret={created.secret} />
      </section>
      <section className="key-setup-block" aria-label="Key setup">
        <div className="key-setup-head">
          <WizardStepHead
            icon={<TerminalSquare />}
            title="Connect your coding agents"
            sub="Choose the tools on this machine, then run the generated installer once."
          />
          {created.apiKeyId ? <VerificationStatus apiKeyId={created.apiKeyId} /> : null}
        </div>
        <fieldset className="harness-picker">
          <legend>Configure for</legend>
          <div className="harness-options">
            {harnessSetupOptions.map((target) => {
              const selected = harnesses.includes(target.value);
              return (
                <label key={target.value} className="harness-option">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(event) => setHarnesses(harnessSetupOptions
                      .map((option) => option.value)
                      .filter((value) => value === target.value ? event.target.checked : harnesses.includes(value)))}
                  />
                  <span className="harness-option-copy">
                    <strong>{target.label}</strong>
                    <span>{target.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {harnesses.length > 0 ? (
          <HarnessSetupGuide
            secret={created.secret}
            harnesses={harnesses}
            model={created.model}
            standalone={false}
          />
        ) : (
          <div className="harness-empty">Choose at least one coding agent to generate setup.</div>
        )}
      </section>
    </GlassCard>
  );
}

function VerificationStatus({ apiKeyId }: { apiKeyId: string }) {
  const { data, error } = useQuery({
    queryKey: ["api-key-verification", apiKeyId],
    queryFn: () => fetchApiKeyVerification(apiKeyId),
    refetchInterval: (query) => (query.state.data?.lastUsedAt ? false : 5000)
  });
  const lastUsedAt = data?.lastUsedAt;
  let state = "waiting";
  let label = "Waiting for traffic";
  let detail = "Updates after the first request";
  let icon = <CircleDashed />;
  if (error) {
    state = "error";
    label = "Verification unavailable";
    detail = error.message;
    icon = <CircleAlert />;
  } else if (lastUsedAt) {
    state = "verified";
    label = "Traffic verified";
    detail = `First request ${formatDateTime(lastUsedAt)}`;
    icon = <CircleCheck />;
  }
  return (
    <div className="key-verification" data-state={state} aria-live="polite">
      {icon}
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </div>
  );
}
