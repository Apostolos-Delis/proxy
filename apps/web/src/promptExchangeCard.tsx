import { MessagesSquare } from "lucide-react";

import { ARTIFACT_KIND_ROLES, artifactPosition } from "./artifactKinds";
import { formatCompact } from "./format";
import { CopyButton } from "./jsonView";
import type { PromptArtifactDetail } from "./promptDetailData";
import { GlassCard } from "./ui";

export function ExchangeCard({ artifacts, focusedArtifactId }: {
  artifacts: PromptArtifactDetail[];
  focusedArtifactId: string;
}) {
  const visible = artifacts
    .filter((artifact) => ARTIFACT_KIND_ROLES[artifact.kind])
    .sort((left, right) => artifactPosition(left) - artifactPosition(right));
  const hasAssistant = visible.some((artifact) => artifact.kind === "assistant_response");
  return (
    <GlassCard className="exchange-card">
      <div className="card-head">
        <div className="card-title"><MessagesSquare />Exchange</div>
        <span className="faint mono">{visible.length} artifacts</span>
      </div>
      <div className="conversation">
        {visible.map((artifact) => (
          <ExchangeBubble key={artifact.artifactId} artifact={artifact} focused={artifact.artifactId === focusedArtifactId} />
        ))}
        {visible.length === 0 ? <div className="empty compact-empty">No prompt content captured for this request.</div> : null}
        {!hasAssistant && visible.length > 0 ? (
          <div className="convo-bubble convo-assistant">
            <div className="convo-bubble-head"><span className="convo-role">assistant</span></div>
            <p className="convo-missing">Response not captured for this request.</p>
          </div>
        ) : null}
      </div>
    </GlassCard>
  );
}

function ExchangeBubble({ artifact, focused }: { artifact: PromptArtifactDetail; focused: boolean }) {
  const { role, label } = ARTIFACT_KIND_ROLES[artifact.kind];
  const text = artifact.rawText ?? artifact.redactedText;
  const meta = [
    artifact.chars != null ? `${formatCompact(artifact.chars)} chars` : null,
    artifact.tokenEstimate ? `~${formatCompact(artifact.tokenEstimate)} tok` : null
  ].filter(Boolean).join(" · ");
  return (
    <div className={`convo-bubble convo-${role}${focused ? " convo-focused" : ""}`}>
      <div className="convo-bubble-head">
        <span className="convo-role">{label}</span>
        <span className="convo-bubble-actions">
          {meta ? <span className="convo-bubble-meta mono">{meta}</span> : null}
          {text ? <CopyButton text={text} /> : null}
        </span>
      </div>
      {text ? <p>{text}</p> : <p className="convo-missing">Content not stored ({artifact.storageMode}).</p>}
    </div>
  );
}
