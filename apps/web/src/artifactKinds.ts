export type ArtifactRole = "system" | "user" | "assistant" | "tool" | "context";

export const ARTIFACT_KIND_ROLES: Record<string, { role: ArtifactRole; label: string }> = {
  system: { role: "system", label: "System prompt" },
  instructions: { role: "system", label: "Instructions" },
  user_message: { role: "user", label: "User" },
  // Retired kind; kept so rows captured before per-message extraction still render.
  latest_user_message: { role: "user", label: "User" },
  injected_context: { role: "context", label: "Injected context" },
  tool_use: { role: "tool", label: "Tool call" },
  tool_result: { role: "tool", label: "Tool result" },
  compression_original_tool_result: { role: "tool", label: "Original tool result" },
  compression_compressed_tool_result: { role: "tool", label: "Compressed tool result" },
  assistant_response: { role: "assistant", label: "Assistant" }
};

// Conversation order: system prompt first, then history position; artifacts
// without an index (the streamed assistant response) close the exchange.
export function artifactPosition(artifact: { kind: string; sourceIndex?: number | null }) {
  if (artifact.sourceIndex != null) return artifact.sourceIndex;
  return ARTIFACT_KIND_ROLES[artifact.kind]?.role === "system" ? -1 : Number.MAX_SAFE_INTEGER;
}

// Order matters: the lowest rank becomes a request's headline prompt in list views.
const PROMPT_LIST_KINDS = [
  "user_message",
  "latest_user_message",
  "system",
  "instructions",
  "injected_context",
  "tool_result",
  "tool_use"
];

export function isListedPromptArtifact(kind: string) {
  return PROMPT_LIST_KINDS.includes(kind);
}

export function promptArtifactRank(kind: string) {
  const rank = PROMPT_LIST_KINDS.indexOf(kind);
  return rank === -1 ? PROMPT_LIST_KINDS.length : rank;
}
