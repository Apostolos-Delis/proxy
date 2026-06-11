import type { PromptProxyTransaction } from "@prompt-proxy/db";

import type { ProxyEvent } from "../events.js";
import type { ModelPricingTable } from "../pricing.js";
import { persistProviderStarted, persistProviderTerminal, persistStreamStarted } from "./providerAttempt.js";
import { persistRequestReceived, persistRoutingContext } from "./requestState.js";
import { persistRouteDecision } from "./routeDecision.js";
import { persistSessionRoute } from "./sessionRoute.js";

export async function projectEvent(tx: PromptProxyTransaction, pricing: ModelPricingTable, event: ProxyEvent) {
  if (event.eventType === "proxy.request_received") {
    await persistRequestReceived(tx, event);
    return;
  }
  if (event.eventType === "routing.context_built") {
    await persistRoutingContext(tx, event);
    return;
  }
  if (event.eventType === "routing.decision_recorded") {
    await persistRouteDecision(tx, event);
    return;
  }
  if (event.eventType === "provider.request_started") {
    await persistProviderStarted(tx, event);
    return;
  }
  if (event.eventType === "provider.stream_started") {
    await persistStreamStarted(tx, event);
    return;
  }
  if (
    event.eventType === "provider.response_completed" ||
    event.eventType === "provider.response_failed" ||
    event.eventType === "provider.response_cancelled"
  ) {
    await persistProviderTerminal(tx, pricing, event);
    return;
  }
  if (event.eventType === "session.route_memory_recorded") {
    await persistSessionRoute(tx, event);
  }
}
