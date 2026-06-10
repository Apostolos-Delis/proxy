import { actorForIdentity, type RequestIdentity } from "./auth.js";
import { jsonPayload, type EventService } from "./events.js";
import {
  promptCaptureEventPayload,
  type CapturedPromptArtifact
} from "./persistence/promptArtifacts.js";
import type { JsonObject, Surface } from "./types.js";

export async function appendPromptCaptureEvent(input: {
  events: EventService;
  identity: RequestIdentity;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  surface: Surface;
  artifacts: CapturedPromptArtifact[];
}) {
  if (input.artifacts.length === 0) return;
  await input.events.append({
    tenantId: input.identity.organizationId,
    workspaceId: input.identity.workspaceId,
    scopeType: "request",
    scopeId: input.requestId,
    sessionId: input.sessionId,
    correlationId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    actor: actorForIdentity(input.identity),
    producer: "prompt-proxy.prompt-artifacts",
    eventType: "prompt_artifacts.captured",
    payload: jsonPayload(promptCaptureEventPayload(input.surface, input.artifacts)) as JsonObject
  });
}
