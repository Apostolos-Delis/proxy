import { actorForIdentity, type RequestIdentity } from "./auth.js";
import { jsonPayload, type EventService } from "./events.js";
import {
  promptCaptureEventPayload,
  type CapturedPromptArtifact
} from "./persistence/promptArtifacts.js";
import type { JsonObject, RouteContext, Surface } from "./types.js";

export async function appendPromptCaptureEvent(input: {
  events: EventService;
  identity: RequestIdentity;
  requestId: string;
  idempotencyKey: string;
  sessionId?: string;
  surface: Surface;
  transport?: RouteContext["transport"];
  harness?: RouteContext["harness"];
  harnessProfileId?: RouteContext["harnessProfileId"];
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
    producer: "proxy.prompt-artifacts",
    eventType: "prompt_artifacts.captured",
    payload: jsonPayload(promptCaptureEventPayload({
      surface: input.surface,
      transport: input.transport ?? "http",
      harness: input.harness,
      harnessProfileId: input.harnessProfileId,
      artifacts: input.artifacts
    })) as JsonObject
  });
}
