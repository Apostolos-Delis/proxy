import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { apiKeys, routingConfigs, type PromptProxyTransaction } from "@prompt-proxy/db";
import { routingConfigSchema, type RoutingConfig } from "@prompt-proxy/schema";

import type { AdminQueryService } from "../../persistence/adminQueries.js";
import type { AdminQueriesFactory } from "./index.js";
import type {
  ConsoleAgentProposalService,
  ProposalRow
} from "../../persistence/consoleAgentProposals.js";
import {
  routingConfigHash,
  routingConfigSlug,
  type RoutingConfigAdminService
} from "../../persistence/routingConfigAdmin.js";
import { sha256, stableJson } from "../../util.js";
import { CapabilityInputError } from "../policy.js";
import type { CapabilityContext, CapabilityRegistry } from "../registry.js";
import { diffConfigs } from "./preview.js";

export type WriteCapabilityDeps = {
  adminQueries: AdminQueriesFactory;
};

const configDocumentInput = z
  .record(z.string(), z.unknown())
  .describe("Full routing config document; run routing_configs.preview.v1 first to validate.");

// Shared between registration (model-facing JSON schema) and executors
// (re-parsing the stored proposal input at approval time).
const createConfigInput = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  config: configDocumentInput
});

const createVersionInput = z.object({
  configId: z.string(),
  config: configDocumentInput
});

const activateVersionInput = z.object({
  configId: z.string(),
  versionId: z.string()
});

const archiveConfigInput = z.object({ configId: z.string() });

const assignRoutingConfigInput = z.object({
  apiKeyId: z.string(),
  routingConfigId: z.string().nullable()
});

export function registerWriteCapabilities(registry: CapabilityRegistry, deps: WriteCapabilityDeps) {
  const { adminQueries } = deps;

  return registry
    .register({
      key: "routing_configs.create.v1",
      description:
        "Propose creating a new routing config with an immutable v1 that activates on approval.",
      input: createConfigInput,
      sideEffect: "write",
      prepareProposal: async (context, input) => {
        const config = parseDraft("routing_configs.create.v1", input.config);
        await rejectDuplicateConfigHash(adminQueries(), "routing_configs.create.v1", config);
        const slug = routingConfigSlug(input.name);
        return {
          preview: {
            action: "create_config",
            name: input.name,
            slug,
            description: input.description ?? null,
            config,
            // Advisory only: proposal input round-trips through jsonb, which can
            // reorder record keys, so the executed version's hash may differ.
            configHash: routingConfigHash(config)
          },
          baseState: { slug },
          dedupeKey: dedupeKeyFor(context, "routing_configs.create.v1", input)
        };
      }
    })
    .register({
      key: "routing_configs.create_version.v1",
      description:
        "Propose a new draft version for an existing routing config. Activation is a separate proposal.",
      input: createVersionInput,
      sideEffect: "write",
      prepareProposal: async (context, input) => {
        const config = parseDraft("routing_configs.create_version.v1", input.config);
        await rejectDuplicateConfigHash(adminQueries(), "routing_configs.create_version.v1", config);
        const base = await activeBaseState(adminQueries(), "routing_configs.create_version.v1", input.configId);
        return {
          preview: {
            action: "create_version",
            configId: input.configId,
            config,
            configHash: routingConfigHash(config),
            diff: base.activeConfig ? diffConfigs(base.activeConfig, config) : null
          },
          baseState: base.baseState,
          dedupeKey: dedupeKeyFor(context, "routing_configs.create_version.v1", input)
        };
      }
    })
    .register({
      key: "routing_configs.activate_version.v1",
      description: "Propose activating an existing version of a routing config (moves live traffic).",
      input: activateVersionInput,
      sideEffect: "write",
      prepareProposal: async (context, input) => {
        const base = await activeBaseState(adminQueries(), "routing_configs.activate_version.v1", input.configId);
        const target = base.versions.find((version) => version.id === input.versionId);
        if (!target) {
          throw new CapabilityInputError("routing_configs.activate_version.v1", [
            `versionId: version ${input.versionId} does not exist on config ${input.configId}`
          ]);
        }
        if (target.status === "archived") {
          throw new CapabilityInputError("routing_configs.activate_version.v1", [
            `versionId: version ${input.versionId} is archived`
          ]);
        }
        return {
          preview: {
            action: "activate_version",
            configId: input.configId,
            versionId: input.versionId,
            currentActiveVersionId: base.baseState.activeVersionId
          },
          baseState: base.baseState,
          dedupeKey: dedupeKeyFor(context, "routing_configs.activate_version.v1", input)
        };
      }
    })
    .register({
      key: "routing_configs.archive.v1",
      description: "Propose archiving a routing config so it can no longer serve traffic.",
      input: archiveConfigInput,
      sideEffect: "write",
      prepareProposal: async (context, input) => {
        const base = await activeBaseState(adminQueries(), "routing_configs.archive.v1", input.configId);
        return {
          preview: { action: "archive_config", configId: input.configId },
          baseState: base.baseState,
          dedupeKey: dedupeKeyFor(context, "routing_configs.archive.v1", input)
        };
      }
    })
    .register({
      key: "api_keys.assign_routing_config.v1",
      description:
        "Propose assigning a routing config to an API key (null clears the assignment back to the org default).",
      input: assignRoutingConfigInput,
      sideEffect: "write",
      prepareProposal: async (context, input) => {
        const detail = await adminQueries().apiKeyDetail(input.apiKeyId);
        if (!detail) {
          throw new CapabilityInputError("api_keys.assign_routing_config.v1", [
            `apiKeyId: API key ${input.apiKeyId} not found`
          ]);
        }
        return {
          preview: {
            action: "assign_routing_config",
            apiKeyId: input.apiKeyId,
            apiKeyName: detail.apiKey.name,
            from: detail.apiKey.routingConfigId,
            to: input.routingConfigId
          },
          baseState: { apiKeyId: input.apiKeyId, routingConfigId: detail.apiKey.routingConfigId },
          dedupeKey: dedupeKeyFor(context, "api_keys.assign_routing_config.v1", input)
        };
      }
    });
}

// Held executions run inside the approval transaction under the approver's
// identity; isStale compares stored fingerprints captured at propose time.
export function registerWriteExecutors(
  proposals: ConsoleAgentProposalService,
  deps: { routingConfigAdmin: RoutingConfigAdminService }
) {
  const { routingConfigAdmin } = deps;

  proposals.registerExecutor("routing_configs.create.v1", {
    execute: async (tx, proposal, approver) => {
      const input = createConfigInput.parse(proposal.input);
      return routingConfigAdmin.createConfig(
        {
          organizationId: approver.organizationId,
          workspaceId: proposal.workspaceId,
          actorUserId: approver.userId,
          body: {
            name: input.name,
            description: input.description,
            config: input.config
          }
        },
        tx
      );
    },
    isStale: async (tx, proposal) => {
      const base = proposal.baseState as { slug?: string } | null;
      const slug = base?.slug;
      if (!slug) return false;
      const [existing] = await tx
        .select({ id: routingConfigs.id })
        .from(routingConfigs)
        .where(and(
          eq(routingConfigs.organizationId, proposal.organizationId),
          eq(routingConfigs.workspaceId, proposal.workspaceId),
          eq(routingConfigs.slug, slug)
        ))
        .limit(1);
      return Boolean(existing);
    }
  });

  proposals.registerExecutor("routing_configs.create_version.v1", {
    execute: async (tx, proposal, approver) => {
      const input = createVersionInput.parse(proposal.input);
      return routingConfigAdmin.createVersion(
        {
          organizationId: approver.organizationId,
          workspaceId: proposal.workspaceId,
          actorUserId: approver.userId,
          configId: input.configId,
          body: { config: input.config }
        },
        tx
      );
    },
    isStale: activeVersionChanged
  });

  proposals.registerExecutor("routing_configs.activate_version.v1", {
    execute: async (tx, proposal, approver) => {
      const input = activateVersionInput.parse(proposal.input);
      return routingConfigAdmin.activateVersion(
        {
          organizationId: approver.organizationId,
          workspaceId: proposal.workspaceId,
          actorUserId: approver.userId,
          configId: input.configId,
          versionId: input.versionId
        },
        tx
      );
    },
    isStale: activeVersionChanged
  });

  proposals.registerExecutor("routing_configs.archive.v1", {
    execute: async (tx, proposal, approver) => {
      const input = archiveConfigInput.parse(proposal.input);
      return routingConfigAdmin.archiveConfig(
        {
          organizationId: approver.organizationId,
          workspaceId: proposal.workspaceId,
          actorUserId: approver.userId,
          configId: input.configId
        },
        tx
      );
    },
    isStale: async (tx, proposal) => {
      const input = archiveConfigInput.parse(proposal.input);
      const [config] = await tx
        .select({ status: routingConfigs.status })
        .from(routingConfigs)
        .where(and(
          eq(routingConfigs.organizationId, proposal.organizationId),
          eq(routingConfigs.id, input.configId)
        ))
        .limit(1);
      return config?.status === "archived";
    }
  });

  proposals.registerExecutor("api_keys.assign_routing_config.v1", {
    execute: async (tx, proposal, approver) => {
      const input = assignRoutingConfigInput.parse(proposal.input);
      return routingConfigAdmin.assignApiKeyRoutingConfig(
        {
          organizationId: approver.organizationId,
          workspaceId: proposal.workspaceId,
          actorUserId: approver.userId,
          apiKeyId: input.apiKeyId,
          body: { routingConfigId: input.routingConfigId }
        },
        tx
      );
    },
    isStale: async (tx, proposal) => {
      const base = proposal.baseState as { apiKeyId: string; routingConfigId: string | null } | null;
      if (!base) return false;
      const [key] = await tx
        .select({ routingConfigId: apiKeys.routingConfigId })
        .from(apiKeys)
        .where(and(
          eq(apiKeys.organizationId, proposal.organizationId),
          eq(apiKeys.id, base.apiKeyId)
        ))
        .limit(1);
      if (!key) return true;
      return (key.routingConfigId ?? null) !== (base.routingConfigId ?? null);
    }
  });

  return proposals;
}

async function activeVersionChanged(tx: PromptProxyTransaction, proposal: ProposalRow) {
  const base = proposal.baseState as { configId?: string; activeVersionId?: string | null } | null;
  const configId = base?.configId;
  if (!configId) return false;
  const [config] = await tx
    .select({ activeVersionId: routingConfigs.activeVersionId, status: routingConfigs.status })
    .from(routingConfigs)
    .where(and(
      eq(routingConfigs.organizationId, proposal.organizationId),
      eq(routingConfigs.id, configId)
    ))
    .limit(1);
  if (!config || config.status === "archived") return true;
  return (config.activeVersionId ?? null) !== (base?.activeVersionId ?? null);
}

async function activeBaseState(
  adminQueries: AdminQueryService,
  capabilityKey: string,
  configId: string
) {
  const detail = await adminQueries.routingConfigDetail(configId);
  if (!detail) {
    throw new CapabilityInputError(capabilityKey, [`configId: routing config ${configId} not found`]);
  }
  const activeVersion = detail.versions.find((version) => version.active);
  return {
    activeConfig: activeVersion?.config ?? null,
    versions: detail.versions,
    baseState: {
      configId,
      activeVersionId: activeVersion?.id ?? null,
      configHash: activeVersion?.configHash ?? null
    }
  };
}

async function rejectDuplicateConfigHash(
  adminQueries: AdminQueryService,
  capabilityKey: string,
  config: RoutingConfig
) {
  const existing = await adminQueries.routingConfigVersionByHash(routingConfigHash(config));
  if (existing) {
    throw new CapabilityInputError(capabilityKey, [
      `config: identical to existing version ${existing.version} of config ${existing.routingConfigId}`
    ]);
  }
}

function parseDraft(capabilityKey: string, draft: Record<string, unknown>) {
  const parsed = routingConfigSchema.safeParse(draft);
  if (!parsed.success) {
    throw new CapabilityInputError(
      capabilityKey,
      parsed.error.issues.map((issue) => `config.${issue.path.join(".") || "(root)"}: ${issue.message}`)
    );
  }
  return parsed.data;
}

function dedupeKeyFor(context: CapabilityContext, capabilityKey: string, input: unknown) {
  return `${context.runId}:${capabilityKey}:${sha256(stableJson(input))}`;
}
