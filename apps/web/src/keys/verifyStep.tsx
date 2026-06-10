import { useQuery } from "@tanstack/react-query";

import { fetchApiKeyVerification } from "../routing/data";
import { Badge, GlassCard } from "../ui";
import { formatDateTime } from "../format";
import { HarnessSetupGuide } from "../harnessSetupCard";
import { CopySecret } from "./copySecret";
import { WizardStepHead } from "./stepHead";
import type { CreatedKeyResult } from "./wizard";

export function VerifyStep({ created }: { created: CreatedKeyResult }) {
  return (
    <>
      <GlassCard>
        <div className="invite-result">
          <div className="row gap-8">
            <Badge variant="success" dot>{created.keyName} created</Badge>
            <span className="faint">Copy the secret now — it is never shown again.</span>
          </div>
          <CopySecret secret={created.secret} />
        </div>
        {created.bindingFailures.length > 0 ? (
          <div className="action-error">
            The key was created, but binding provider keys failed: {created.bindingFailures.join("; ")}.
            Bind them from the API keys table.
          </div>
        ) : null}
      </GlassCard>
      <GlassCard>
        <HarnessSetupGuide secret={created.secret} showKeyContextSteps={false} />
      </GlassCard>
      {created.apiKeyId ? <VerificationCard apiKeyId={created.apiKeyId} /> : null}
    </>
  );
}

function VerificationCard({ apiKeyId }: { apiKeyId: string }) {
  const verification = useQuery({
    queryKey: ["api-key-verification", apiKeyId],
    queryFn: () => fetchApiKeyVerification(apiKeyId),
    refetchInterval: (query) => (query.state.data?.lastUsedAt ? false : 5000)
  });
  const lastUsedAt = verification.data?.lastUsedAt;
  return (
    <GlassCard>
      <WizardStepHead
        title="Verify the key works"
        sub="Launch your agent with the snippet above — this updates as soon as the first request lands."
      />
      <div className="verify-status">
        {lastUsedAt ? (
          <Badge variant="success" dot>Verified — first request {formatDateTime(lastUsedAt)}</Badge>
        ) : (
          <Badge variant="warn" dot>Waiting for the first request…</Badge>
        )}
        {verification.error ? <span className="action-error">{verification.error.message}</span> : null}
      </div>
    </GlassCard>
  );
}
