import { useQuery } from "@tanstack/react-query";

import { fetchApiKeyVerification } from "../routing/data";
import { GlassCard, StatusIndicator } from "../ui";
import { formatDateTime } from "../format";
import { HarnessSetupGuide } from "../harnessSetupCard";
import { CopySecret } from "./copySecret";
import { WizardStepHead } from "./stepHead";
import type { CreatedKeyResult } from "./wizard";

export function VerifyStep({ created }: { created: CreatedKeyResult }) {
  return (
    <>
      <GlassCard>
        <div className="key-secret-result">
          <div className="key-secret-head">
            <StatusIndicator status="created">{created.keyName} created</StatusIndicator>
            <span className="faint">Copy the secret now — it is never shown again.</span>
          </div>
          <CopySecret secret={created.secret} />
        </div>
      </GlassCard>
      <GlassCard>
        <HarnessSetupGuide
          secret={created.secret}
          harnesses={created.harnesses}
          model={created.model}
          showKeyContextSteps={false}
        />
      </GlassCard>
      {created.apiKeyId ? <VerificationCard apiKeyId={created.apiKeyId} /> : null}
    </>
  );
}

function VerificationCard({ apiKeyId }: { apiKeyId: string }) {
  const { data: verificationData, error: verificationError } = useQuery({
    queryKey: ["api-key-verification", apiKeyId],
    queryFn: () => fetchApiKeyVerification(apiKeyId),
    refetchInterval: (query) => (query.state.data?.lastUsedAt ? false : 5000)
  });
  const lastUsedAt = verificationData?.lastUsedAt;
  return (
    <GlassCard>
      <WizardStepHead
        title="Verify the key works"
        sub="Launch your agent with the snippet above — this updates as soon as the first request lands."
      />
      <div className="verify-status">
        {lastUsedAt ? (
          <StatusIndicator status="verified">Verified — first request {formatDateTime(lastUsedAt)}</StatusIndicator>
        ) : (
          <StatusIndicator status="waiting">Waiting for the first request…</StatusIndicator>
        )}
        {verificationError ? <span className="action-error">{verificationError.message}</span> : null}
      </div>
    </GlassCard>
  );
}
