import type { PromptProxyTransaction } from "@prompt-proxy/db";

import type { ProxyEvent } from "../events.js";
import { persistBudgetReserved, persistBudgetSignal } from "./budgetWindows.js";
import { persistClassifierUsage } from "./classifierUsage.js";
import { persistCompressionReceipts } from "./compressionReceipts.js";
import { persistProviderStarted, persistProviderTerminal, persistStreamStarted } from "./providerAttempt.js";
import { projectProviderHealthProbe, projectProviderHealthTerminal } from "./providerHealth.js";
import { persistRequestReceived, persistRoutingContext } from "./requestState.js";
import { persistRouteDecision } from "./routeDecision.js";
import { persistSessionRoute } from "./sessionRoute.js";

export async function projectEvent(tx: PromptProxyTransaction, event: ProxyEvent) {
  if (event.eventType === "proxy.request_received") {
    await persistRequestReceived(tx, event);
    return;
  }
  if (event.eventType === "routing.context_built") {
    await persistRoutingContext(tx, event);
    return;
  }
  if (event.eventType === "routing.decision_recorded" || event.eventType === "routing.plan_recorded") {
    await persistRouteDecision(tx, event);
    return;
  }
  if (event.eventType === "routing.classification_recorded") {
    await persistClassifierUsage(tx, event);
    return;
  }
  if (event.eventType === "compression.recorded" || event.eventType === "compression.measurement_recorded") {
    await persistCompressionReceipts(tx, event);
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
    await persistProviderTerminal(tx, event);
    await projectProviderHealthTerminal(tx, event);
    return;
  }
  if (event.eventType === "provider_account.health_probe_completed") {
    await projectProviderHealthProbe(tx, event);
    return;
  }
  if (event.eventType === "session.route_memory_recorded") {
    await persistSessionRoute(tx, event);
    return;
  }
  if (event.eventType === "budget.reserved") {
    await persistBudgetReserved(tx, event);
    return;
  }
  if (event.eventType === "budget.warning_emitted" || event.eventType === "budget.exceeded") {
    await persistBudgetSignal(tx, event);
  }
}
