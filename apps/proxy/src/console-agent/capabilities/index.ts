import type { ModelCatalog } from "../../catalog.js";
import type { AdminQueryService } from "../../persistence/adminQueries.js";

// Main's AdminQueryService caches per instance (request-scoped); the agent
// builds a fresh one per capability call so reads never serve stale data.
export type AdminQueriesFactory = () => AdminQueryService;
import type { ConsoleAgentProposalService } from "../../persistence/consoleAgentProposals.js";
import type { PromptAccessAuditStore } from "../../persistence/promptAccessAudit.js";
import type { RoutingConfigAdminService } from "../../persistence/routingConfigAdmin.js";
import { CapabilityRegistry } from "../registry.js";
import { registerPreviewCapability } from "./preview.js";
import { registerReadCapabilities } from "./read.js";
import { registerWriteCapabilities, registerWriteExecutors } from "./write.js";

export type ConsoleAgentRegistryDeps = {
  adminQueries: AdminQueriesFactory;
  promptAccessAudit: PromptAccessAuditStore;
  catalog: ModelCatalog;
};

export function buildConsoleAgentRegistry(deps: ConsoleAgentRegistryDeps) {
  const registry = registerReadCapabilities(new CapabilityRegistry(), deps);
  registerPreviewCapability(registry, { adminQueries: deps.adminQueries });
  return registerWriteCapabilities(registry, { adminQueries: deps.adminQueries });
}

export function registerConsoleAgentExecutors(
  proposals: ConsoleAgentProposalService,
  deps: { routingConfigAdmin: RoutingConfigAdminService }
) {
  return registerWriteExecutors(proposals, deps);
}
