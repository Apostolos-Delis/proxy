import { undatedModel } from "../pricing.js";
import { writeSettingsFile } from "../settings.js";
import { requireAdminRole } from "./authz.js";
import { builder } from "./builder.js";
import { scopedQueries, viewerPayload } from "./context.js";
import { adminGraphQLError, mapAdminError, notFoundError } from "./errors.js";
import { inviteUrl, sendInvitationEmail } from "./invitationDelivery.js";
import { promptCaptureSettings, settingsResponse } from "./settingsPayload.js";
import { MemberRole, ProviderAccountAuthType } from "./types/core.js";
import {
  AcceptedInvitation,
  Invitation,
  InvitationActionResult,
  UpdateUserRoleResult,
  UserStatusResult
} from "./types/invitations.js";
import { ModelPricingEntry } from "./types/pricing.js";
import { ApiKey, CreateApiKeyResult, ProviderAccount, RoutingConfigDetail } from "./types/routing.js";
import { PromptCaptureConfig, Settings, SettingsInput } from "./types/settings.js";
import { Viewer, WorkspaceSummary } from "./types/viewer.js";

const CreateRoutingConfigInput = builder.inputType("CreateRoutingConfigInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    description: t.string(),
    config: t.field({ type: "JSON", required: true })
  })
});

const CreateApiKeyInput = builder.inputType("CreateApiKeyInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    scopes: t.stringList(),
    routingConfigId: t.id()
  })
});

const CreateProviderCredentialInput = builder.inputType("CreateProviderCredentialInput", {
  fields: (t) => ({
    provider: t.string({ required: true }),
    name: t.string({ required: true }),
    authType: t.field({ type: ProviderAccountAuthType }),
    baseUrl: t.string(),
    // Carries the API key or, for authType "oauth", the subscription token.
    apiKey: t.string({ required: true }),
    chatgptAccountId: t.string()
  })
});

const CreateWorkspaceInput = builder.inputType("CreateWorkspaceInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    slug: t.string(),
    description: t.string()
  })
});

const CreateInvitationInput = builder.inputType("CreateInvitationInput", {
  fields: (t) => ({
    email: t.string({ required: true }),
    name: t.string(),
    role: t.field({ type: MemberRole, required: true })
  })
});

const SetModelPricingInput = builder.inputType("SetModelPricingInput", {
  fields: (t) => ({
    provider: t.string({ required: true }),
    model: t.string({ required: true }),
    inputCostPerMtok: t.float({ required: true }),
    outputCostPerMtok: t.float({ required: true }),
    cacheReadCostPerMtok: t.float(),
    cacheWriteCostPerMtok: t.float()
  })
});

// An unpriced baseline model would book baseline $0 and silently flip
// savings to -spent, and the ledger-driven unpriced-traffic warning never
// covers it (baseline models do not appear in the ledger). Reject it here,
// against effective pricing (defaults, env, and org overrides; dated names
// resolve through their undated entry). Empty values clear to the
// always-priced defaults.
async function assertBaselineModelsPriced(
  context: Parameters<typeof scopedQueries>[0],
  costBaseline: { anthropicMessagesModel: string; openaiResponsesModel: string; openaiChatModel: string }
) {
  const queries = scopedQueries(context);
  if (!queries) return;
  const entries = await queries.modelPricing();
  const priced = new Set(
    entries.filter((entry) => entry.source !== "unpriced").map((entry) => entry.model)
  );
  for (const model of [
    costBaseline.anthropicMessagesModel.trim(),
    costBaseline.openaiResponsesModel.trim(),
    costBaseline.openaiChatModel.trim()
  ]) {
    if (!model || priced.has(model) || priced.has(undatedModel(model))) continue;
    throw adminGraphQLError(`baseline_model_unpriced: ${model}`, 400);
  }
}

function mapSettingsError(error: unknown): never {
  if (error instanceof Error && error.message === "settings_file_invalid_json") {
    throw adminGraphQLError("settings_file_invalid_json", 400);
  }
  if (error && typeof error === "object" && "issues" in error) {
    throw adminGraphQLError("invalid_settings", 400, (error as { issues: unknown }).issues);
  }
  throw error;
}

builder.mutationFields((t) => ({
  login: t.field({
    type: Viewer,
    args: {
      email: t.arg.string({ required: true }),
      password: t.arg.string({ required: true })
    },
    resolve: async (_root, args, context) => {
      try {
        const session = await context.adminAuth.login({
          email: args.email,
          password: args.password
        });
        context.setSessionCookie(
          context.adminAuth.sessionCookie(session.token, session.expiresAt)
        );
        return await viewerPayload(session.identity, context.persistence);
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  logout: t.boolean({
    resolve: async (_root, _args, context) => {
      await context.adminAuth.logout(context.requestHeaders);
      context.setSessionCookie(context.adminAuth.clearCookie());
      return true;
    }
  }),

  switchOrganization: t.field({
    type: Viewer,
    args: { organizationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      try {
        const session = await context.adminAuth.switchOrganization(context.requestHeaders, {
          organizationId: String(args.organizationId)
        });
        context.setSessionCookie(
          context.adminAuth.sessionCookie(session.token, session.expiresAt)
        );
        return await viewerPayload(session.identity, context.persistence);
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  switchWorkspace: t.field({
    type: Viewer,
    args: { workspaceId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      try {
        const identity = await context.adminAuth.switchWorkspace(context.requestHeaders, {
          workspaceId: String(args.workspaceId)
        });
        return await viewerPayload(identity, context.persistence);
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  createWorkspace: t.field({
    type: WorkspaceSummary,
    args: { input: t.arg({ type: CreateWorkspaceInput, required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("workspaces_not_found");
      const identity = requireAdminRole(context);
      try {
        const created = await context.persistence.workspaceAdmin.createWorkspace({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          body: {
            name: args.input.name,
            slug: args.input.slug ?? undefined,
            description: args.input.description ?? undefined
          }
        });
        return {
          id: created.workspaceId,
          slug: created.slug,
          name: created.name
        };
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  acceptInvitation: t.field({
    type: AcceptedInvitation,
    args: {
      token: t.arg.string({ required: true }),
      name: t.arg.string()
    },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("invitation_not_found");
      try {
        const accepted = await context.persistence.userAdmin.acceptInvitation({
          body: args.name ? { token: args.token, name: args.name } : { token: args.token }
        });
        return { ok: true, ...accepted };
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  updateSettings: t.field({
    type: Settings,
    args: { input: t.arg({ type: SettingsInput, required: true }) },
    resolve: async (_root, args, context) => {
      try {
        const identity = requireAdminRole(context);
        const {
          systemPrompt,
          cacheTtlUpgrade,
          automaticCaching,
          toolResultCompression,
          duplicateToolResultReferences,
          costBaseline,
          ...fileInput
        } = args.input;
        if (context.persistence && costBaseline) {
          await assertBaselineModelsPriced(context, costBaseline);
        }
        const settings = await writeSettingsFile(context.config.settingsPath, fileInput);
        if (
          context.persistence &&
          settings.promptCapture.promptCaptureMode !== undefined &&
          settings.promptCapture.retentionDays !== undefined
        ) {
          await context.persistence.promptArtifacts.configure({
            organizationId: identity.organizationId,
            promptCaptureMode: settings.promptCapture.promptCaptureMode,
            retentionDays: settings.promptCapture.retentionDays
          });
        }
        if (context.persistence && systemPrompt !== undefined) {
          await context.persistence.organizationSettings.setSystemPrompt(
            identity.organizationId,
            systemPrompt?.trim() ? systemPrompt.trim() : null
          );
        }
        if (context.persistence && cacheTtlUpgrade !== undefined && cacheTtlUpgrade !== null) {
          await context.persistence.organizationSettings.setCacheTtlUpgrade(
            identity.organizationId,
            cacheTtlUpgrade
          );
        }
        if (context.persistence && automaticCaching !== undefined && automaticCaching !== null) {
          await context.persistence.organizationSettings.setAutomaticCaching(
            identity.organizationId,
            automaticCaching
          );
        }
        if (context.persistence && toolResultCompression !== undefined && toolResultCompression !== null) {
          await context.persistence.organizationSettings.setToolResultCompression(
            identity.organizationId,
            toolResultCompression
          );
        }
        if (context.persistence && duplicateToolResultReferences !== undefined && duplicateToolResultReferences !== null) {
          await context.persistence.organizationSettings.setDuplicateToolResultReferences(
            identity.organizationId,
            duplicateToolResultReferences
          );
        }
        if (context.persistence && costBaseline) {
          await context.persistence.organizationSettings.setCostBaseline(
            identity.organizationId,
            costBaseline
          );
        }
        return await settingsResponse(
          context.config,
          identity.organizationId,
          settings,
          context.persistence
        );
      } catch (error) {
        mapSettingsError(error);
      }
    }
  }),

  configurePromptCapture: t.field({
    type: PromptCaptureConfig,
    args: {
      promptCaptureMode: t.arg.string({ required: true }),
      retentionDays: t.arg.int({ required: true })
    },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("prompt_capture_settings_not_found");
      const identity = requireAdminRole(context);
      try {
        return await context.persistence.promptArtifacts.configure({
          organizationId: identity.organizationId,
          ...promptCaptureSettings({
            promptCaptureMode: args.promptCaptureMode,
            retentionDays: args.retentionDays
          })
        });
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  setModelPricing: t.field({
    type: [ModelPricingEntry],
    args: { input: t.arg({ type: SetModelPricingInput, required: true }) },
    resolve: async (_root, args, context) => {
      const identity = requireAdminRole(context);
      const queries = scopedQueries(context);
      if (!context.persistence || !queries) throw notFoundError("model_pricing_unavailable");
      try {
        await context.persistence.modelPricingAdmin.setPricing({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          body: {
            provider: args.input.provider,
            model: args.input.model,
            inputCostPerMtok: args.input.inputCostPerMtok,
            outputCostPerMtok: args.input.outputCostPerMtok,
            ...(args.input.cacheReadCostPerMtok == null ? {} : { cacheReadCostPerMtok: args.input.cacheReadCostPerMtok }),
            ...(args.input.cacheWriteCostPerMtok == null ? {} : { cacheWriteCostPerMtok: args.input.cacheWriteCostPerMtok })
          }
        });
        queries.invalidateModelPricing();
        return await queries.modelPricing();
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  clearModelPricing: t.field({
    type: [ModelPricingEntry],
    args: {
      provider: t.arg.string({ required: true }),
      model: t.arg.string({ required: true })
    },
    resolve: async (_root, args, context) => {
      const identity = requireAdminRole(context);
      const queries = scopedQueries(context);
      if (!context.persistence || !queries) throw notFoundError("model_pricing_unavailable");
      try {
        await context.persistence.modelPricingAdmin.clearPricing({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          body: {
            provider: args.provider,
            model: args.model
          }
        });
        queries.invalidateModelPricing();
        return await queries.modelPricing();
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  createRoutingConfig: t.field({
    type: RoutingConfigDetail,
    args: { input: t.arg({ type: CreateRoutingConfigInput, required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("routing_configs_not_found");
      const identity = requireAdminRole(context);
      try {
        const created = await context.persistence.routingConfigAdmin.createConfig({
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          actorUserId: identity.userId,
          body: {
            name: args.input.name,
            description: args.input.description ?? null,
            config: args.input.config
          }
        });
        const detail = await scopedQueries(context)?.routingConfigDetail(created.configId);
        if (!detail) throw notFoundError("routing_config_not_found");
        return detail;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  createRoutingConfigVersion: t.field({
    type: RoutingConfigDetail,
    args: {
      configId: t.arg.id({ required: true }),
      config: t.arg({ type: "JSON", required: true })
    },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("routing_config_not_found");
      const configId = String(args.configId);
      const identity = requireAdminRole(context);
      try {
        await context.persistence.routingConfigAdmin.createVersion({
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          actorUserId: identity.userId,
          configId,
          body: { config: args.config }
        });
        const detail = await scopedQueries(context)?.routingConfigDetail(configId);
        if (!detail) throw notFoundError("routing_config_not_found");
        return detail;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  activateRoutingConfigVersion: t.field({
    type: RoutingConfigDetail,
    args: {
      configId: t.arg.id({ required: true }),
      versionId: t.arg.id({ required: true })
    },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("routing_config_version_not_found");
      const configId = String(args.configId);
      const identity = requireAdminRole(context);
      try {
        await context.persistence.routingConfigAdmin.activateVersion({
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          actorUserId: identity.userId,
          configId,
          versionId: String(args.versionId)
        });
        const detail = await scopedQueries(context)?.routingConfigDetail(configId);
        if (!detail) throw notFoundError("routing_config_not_found");
        return detail;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  archiveRoutingConfig: t.field({
    type: RoutingConfigDetail,
    args: { configId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("routing_config_not_found");
      const configId = String(args.configId);
      const identity = requireAdminRole(context);
      try {
        await context.persistence.routingConfigAdmin.archiveConfig({
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          actorUserId: identity.userId,
          configId
        });
        const detail = await scopedQueries(context)?.routingConfigDetail(configId);
        if (!detail) throw notFoundError("routing_config_not_found");
        return detail;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  createApiKey: t.field({
    type: CreateApiKeyResult,
    args: { input: t.arg({ type: CreateApiKeyInput, required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("api_keys_not_found");
      const identity = requireAdminRole(context);
      try {
        const created = await context.persistence.apiKeyAdmin.createApiKey({
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          actorUserId: identity.userId,
          body: {
            name: args.input.name,
            scopes: args.input.scopes ?? undefined,
            routingConfigId: args.input.routingConfigId ? String(args.input.routingConfigId) : null
          }
        });
        const detail = await scopedQueries(context)?.apiKeyDetail(created.apiKeyId);
        return {
          apiKey: detail?.apiKey ?? null,
          secret: created.secret
        };
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  revokeApiKey: t.field({
    type: ApiKey,
    args: { apiKeyId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("api_key_not_found");
      const apiKeyId = String(args.apiKeyId);
      const identity = requireAdminRole(context);
      try {
        await context.persistence.apiKeyAdmin.revokeApiKey({
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          actorUserId: identity.userId,
          apiKeyId
        });
        const detail = await scopedQueries(context)?.apiKeyDetail(apiKeyId);
        if (!detail) throw notFoundError("api_key_not_found");
        return detail.apiKey;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  assignApiKeyRoutingConfig: t.field({
    type: ApiKey,
    args: {
      apiKeyId: t.arg.id({ required: true }),
      routingConfigId: t.arg.id()
    },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("api_key_not_found");
      const apiKeyId = String(args.apiKeyId);
      const identity = requireAdminRole(context);
      try {
        await context.persistence.routingConfigAdmin.assignApiKeyRoutingConfig({
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          actorUserId: identity.userId,
          apiKeyId,
          body: { routingConfigId: args.routingConfigId ? String(args.routingConfigId) : null }
        });
        const detail = await scopedQueries(context)?.apiKeyDetail(apiKeyId);
        if (!detail) throw notFoundError("api_key_not_found");
        return detail.apiKey;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  createProviderCredential: t.field({
    type: ProviderAccount,
    nullable: true,
    args: { input: t.arg({ type: CreateProviderCredentialInput, required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("provider_accounts_not_found");
      const identity = requireAdminRole(context);
      try {
        const created = await context.persistence.providerCredentialAdmin.createCredential({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          body: {
            provider: args.input.provider,
            name: args.input.name,
            authType: args.input.authType ?? undefined,
            baseUrl: args.input.baseUrl ?? undefined,
            apiKey: args.input.apiKey,
            chatgptAccountId: args.input.chatgptAccountId ?? undefined
          }
        });
        const accounts = (await scopedQueries(context)?.providerAccounts())?.data ?? [];
        return accounts.find((account) => account.id === created.providerAccountId) ?? null;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  revokeProviderCredential: t.field({
    type: ProviderAccount,
    nullable: true,
    args: { providerAccountId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("provider_credential_not_found");
      const providerAccountId = String(args.providerAccountId);
      const identity = requireAdminRole(context);
      try {
        await context.persistence.providerCredentialAdmin.revokeCredential({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          providerAccountId
        });
        const accounts = (await scopedQueries(context)?.providerAccounts())?.data ?? [];
        return accounts.find((account) => account.id === providerAccountId) ?? null;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  assignApiKeyProviderAccount: t.field({
    type: ApiKey,
    args: {
      apiKeyId: t.arg.id({ required: true }),
      provider: t.arg.string({ required: true }),
      providerAccountId: t.arg.id()
    },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("api_key_not_found");
      const apiKeyId = String(args.apiKeyId);
      const identity = requireAdminRole(context);
      try {
        await context.persistence.providerCredentialAdmin.bindApiKeyCredential({
          organizationId: identity.organizationId,
          workspaceId: identity.workspaceId,
          actorUserId: identity.userId,
          apiKeyId,
          body: {
            provider: args.provider,
            providerAccountId: args.providerAccountId ? String(args.providerAccountId) : null
          }
        });
        const detail = await scopedQueries(context)?.apiKeyDetail(apiKeyId);
        if (!detail) throw notFoundError("api_key_not_found");
        return detail.apiKey;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  createInvitation: t.field({
    type: InvitationActionResult,
    args: { input: t.arg({ type: CreateInvitationInput, required: true }) },
    resolve: async (_root, args, context) => {
      const identity = requireAdminRole(context);
      const queries = scopedQueries(context);
      if (!context.persistence || !queries) throw notFoundError("invitations_not_found");
      try {
        const created = await context.persistence.userAdmin.createInvitation({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          body: {
            email: args.input.email,
            name: args.input.name ?? undefined,
            role: args.input.role
          }
        });
        const invitation = (await queries.invitationDetail(created.invitationId))?.invitation ?? null;
        const emailDelivery = await sendInvitationEmail(queries, context.config, context.emailService, {
          invitation,
          token: created.token,
          inviterName: identity.name ?? identity.email
        });
        return {
          invitation,
          inviteUrl: inviteUrl(context.config, created.token),
          emailDelivery
        };
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  resendInvitation: t.field({
    type: InvitationActionResult,
    args: { invitationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      const identity = requireAdminRole(context);
      const queries = scopedQueries(context);
      if (!context.persistence || !queries) throw notFoundError("invitation_not_found");
      const invitationId = String(args.invitationId);
      try {
        const resent = await context.persistence.userAdmin.resendInvitation({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          invitationId
        });
        const invitation = (await queries.invitationDetail(invitationId))?.invitation ?? null;
        const emailDelivery = await sendInvitationEmail(queries, context.config, context.emailService, {
          invitation,
          token: resent.token,
          inviterName: identity.name ?? identity.email
        });
        return {
          invitation,
          inviteUrl: inviteUrl(context.config, resent.token),
          emailDelivery
        };
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  revokeInvitation: t.field({
    type: Invitation,
    nullable: true,
    args: { invitationId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("invitation_not_found");
      const invitationId = String(args.invitationId);
      const identity = requireAdminRole(context);
      try {
        await context.persistence.userAdmin.revokeInvitation({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          invitationId
        });
        const detail = await scopedQueries(context)?.invitationDetail(invitationId);
        return detail?.invitation ?? null;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  updateUserRole: t.field({
    type: UpdateUserRoleResult,
    args: {
      userId: t.arg.id({ required: true }),
      role: t.arg({ type: MemberRole, required: true })
    },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("member_not_found");
      const identity = requireAdminRole(context);
      try {
        return await context.persistence.userAdmin.updateMemberRole({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          userId: String(args.userId),
          body: { role: args.role }
        });
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  deactivateUser: t.field({
    type: UserStatusResult,
    args: { userId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("member_not_found");
      const identity = requireAdminRole(context);
      try {
        return await context.persistence.userAdmin.deactivateMember({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          userId: String(args.userId)
        });
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  reactivateUser: t.field({
    type: UserStatusResult,
    args: { userId: t.arg.id({ required: true }) },
    resolve: async (_root, args, context) => {
      if (!context.persistence) throw notFoundError("member_not_found");
      const identity = requireAdminRole(context);
      try {
        return await context.persistence.userAdmin.reactivateMember({
          organizationId: identity.organizationId,
          actorUserId: identity.userId,
          userId: String(args.userId)
        });
      } catch (error) {
        mapAdminError(error);
      }
    }
  })
}));
