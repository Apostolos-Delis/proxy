import { writeSettingsFile } from "../settings.js";
import { requireAdminRole } from "./authz.js";
import { builder } from "./builder.js";
import { scopedQueries, viewerPayload } from "./context.js";
import { adminGraphQLError, mapAdminError, notFoundError } from "./errors.js";
import { inviteUrl, sendInvitationEmail } from "./invitationDelivery.js";
import { promptCaptureSettings, settingsResponse } from "./settingsPayload.js";
import { MemberRole } from "./types/core.js";
import {
  AcceptedInvitation,
  Invitation,
  InvitationActionResult,
  UpdateUserRoleResult,
  UserStatusResult
} from "./types/invitations.js";
import { ApiKey, CreateApiKeyResult } from "./types/routing.js";
import { PromptCaptureConfig, Settings, SettingsInput } from "./types/settings.js";
import { Viewer, WorkspaceSummary } from "./types/viewer.js";

const CreateApiKeyInput = builder.inputType("CreateApiKeyInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    accessProfileId: t.id({ required: true })
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
        const session = await context.adminAuth.login({ email: args.email, password: args.password });
        context.setSessionCookie(context.adminAuth.sessionCookie(session.token, session.expiresAt));
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
        context.setSessionCookie(context.adminAuth.sessionCookie(session.token, session.expiresAt));
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
        return { id: created.workspaceId, slug: created.slug, name: created.name };
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  acceptInvitation: t.field({
    type: AcceptedInvitation,
    args: { token: t.arg.string({ required: true }), name: t.arg.string() },
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
          toolResultCompressionPolicy,
          duplicateToolResultReferences,
          costBaseline,
          ...fileInput
        } = args.input;
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
        if (context.persistence && cacheTtlUpgrade != null) {
          await context.persistence.organizationSettings.setCacheTtlUpgrade(identity.organizationId, cacheTtlUpgrade);
        }
        if (context.persistence && automaticCaching != null) {
          await context.persistence.organizationSettings.setAutomaticCaching(identity.organizationId, automaticCaching);
        }
        if (context.persistence && toolResultCompressionPolicy != null) {
          await context.persistence.organizationSettings.setToolResultCompressionPolicy(
            identity.organizationId,
            toolResultCompressionPolicy
          );
        }
        if (context.persistence && duplicateToolResultReferences != null) {
          await context.persistence.organizationSettings.setDuplicateToolResultReferences(
            identity.organizationId,
            duplicateToolResultReferences
          );
        }
        if (context.persistence && costBaseline) {
          await context.persistence.organizationSettings.setCostBaseline(identity.organizationId, costBaseline);
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
          body: { name: args.input.name, accessProfileId: String(args.input.accessProfileId) }
        });
        const detail = await scopedQueries(context)?.apiKeyDetail(created.apiKeyId);
        return { apiKey: detail?.apiKey ?? null, secret: created.secret };
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
          body: { email: args.input.email, name: args.input.name ?? undefined, role: args.input.role }
        });
        const invitation = (await queries.invitationDetail(created.invitationId))?.invitation ?? null;
        const emailDelivery = await sendInvitationEmail(queries, context.config, context.emailService, {
          invitation,
          token: created.token,
          inviterName: identity.name ?? identity.email
        });
        return { invitation, inviteUrl: inviteUrl(context.config, created.token), emailDelivery };
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
        return { invitation, inviteUrl: inviteUrl(context.config, resent.token), emailDelivery };
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
        return (await scopedQueries(context)?.invitationDetail(invitationId))?.invitation ?? null;
      } catch (error) {
        mapAdminError(error);
      }
    }
  }),

  updateUserRole: t.field({
    type: UpdateUserRoleResult,
    args: { userId: t.arg.id({ required: true }), role: t.arg({ type: MemberRole, required: true }) },
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
