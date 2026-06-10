import type { FastifyInstance, FastifyReply } from "fastify";

import type { AdminAuthService } from "./adminAuth.js";
import type { AppConfig } from "./config.js";
import type { EmailService } from "./email.js";
import { invitationEmail } from "./emailTemplates.js";
import type { createDatabasePersistence } from "./persistence/index.js";
import { UserAdminError } from "./persistence/userAdmin.js";

type UserAdminRouteDeps = {
  config: AppConfig;
  adminAuth: AdminAuthService;
  emailService: EmailService;
  persistence?: ReturnType<typeof createDatabasePersistence>;
};

export function registerUserAdminRoutes(app: FastifyInstance, deps: UserAdminRouteDeps) {
  const { config, adminAuth, emailService, persistence } = deps;

  app.get("/admin/invitations", async (request) => {
    await adminAuth.resolve(request.headers);
    if (!persistence) return { data: [] };
    return persistence.adminQueries.invitations();
  });

  app.post("/admin/invitations", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    if (!persistence) throw notFound("invitations_not_found");
    try {
      const created = await persistence.userAdmin.createInvitation({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        body: request.body
      });
      const emailDelivery = await sendInvitationEmail(persistence, config, emailService, {
        invitationId: created.invitationId,
        token: created.token,
        inviterName: identity.name ?? identity.email
      });
      const detail = await persistence.adminQueries.invitationDetail(created.invitationId);
      reply.code(201);
      return {
        invitation: detail?.invitation ?? null,
        inviteUrl: inviteUrl(config, created.token),
        emailDelivery
      };
    } catch (error) {
      if (sendUserAdminError(error, reply)) return;
      throw error;
    }
  });

  app.post("/admin/invitations/:invitationId/resend", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { invitationId?: string };
    const invitationId = params.invitationId;
    if (!invitationId || !persistence) {
      reply.code(404).send({ error: "invitation_not_found" });
      return;
    }
    try {
      const resent = await persistence.userAdmin.resendInvitation({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        invitationId
      });
      const emailDelivery = await sendInvitationEmail(persistence, config, emailService, {
        invitationId,
        token: resent.token,
        inviterName: identity.name ?? identity.email
      });
      const detail = await persistence.adminQueries.invitationDetail(invitationId);
      return {
        invitation: detail?.invitation ?? null,
        inviteUrl: inviteUrl(config, resent.token),
        emailDelivery
      };
    } catch (error) {
      if (sendUserAdminError(error, reply)) return;
      throw error;
    }
  });

  app.post("/admin/invitations/:invitationId/revoke", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { invitationId?: string };
    const invitationId = params.invitationId;
    if (!invitationId || !persistence) {
      reply.code(404).send({ error: "invitation_not_found" });
      return;
    }
    try {
      await persistence.userAdmin.revokeInvitation({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        invitationId
      });
      return persistence.adminQueries.invitationDetail(invitationId);
    } catch (error) {
      if (sendUserAdminError(error, reply)) return;
      throw error;
    }
  });

  app.patch("/admin/users/:userId/role", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { userId?: string };
    const userId = params.userId;
    if (!userId || !persistence) {
      reply.code(404).send({ error: "member_not_found" });
      return;
    }
    try {
      return await persistence.userAdmin.updateMemberRole({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        userId,
        body: request.body
      });
    } catch (error) {
      if (sendUserAdminError(error, reply)) return;
      throw error;
    }
  });

  app.post("/admin/users/:userId/deactivate", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { userId?: string };
    const userId = params.userId;
    if (!userId || !persistence) {
      reply.code(404).send({ error: "member_not_found" });
      return;
    }
    try {
      return await persistence.userAdmin.deactivateMember({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        userId
      });
    } catch (error) {
      if (sendUserAdminError(error, reply)) return;
      throw error;
    }
  });

  app.post("/admin/users/:userId/reactivate", async (request, reply) => {
    const identity = await adminAuth.resolve(request.headers);
    const params = request.params as { userId?: string };
    const userId = params.userId;
    if (!userId || !persistence) {
      reply.code(404).send({ error: "member_not_found" });
      return;
    }
    try {
      return await persistence.userAdmin.reactivateMember({
        organizationId: identity.organizationId,
        actorUserId: identity.userId,
        userId
      });
    } catch (error) {
      if (sendUserAdminError(error, reply)) return;
      throw error;
    }
  });

  app.post("/api/invitations/resolve", async (request, reply) => {
    if (!persistence) {
      reply.code(404).send({ error: "invitation_not_found" });
      return;
    }
    const token = tokenFromBody(request.body);
    const invitation = token ? await persistence.userAdmin.resolveInvitation(token) : null;
    if (!invitation) {
      reply.code(404).send({ error: "invitation_not_found" });
      return;
    }
    return { invitation };
  });

  app.post("/api/invitations/accept", async (request, reply) => {
    if (!persistence) {
      reply.code(404).send({ error: "invitation_not_found" });
      return;
    }
    try {
      const accepted = await persistence.userAdmin.acceptInvitation({ body: request.body });
      return { ok: true, ...accepted };
    } catch (error) {
      if (sendUserAdminError(error, reply)) return;
      throw error;
    }
  });
}

async function sendInvitationEmail(
  persistence: NonNullable<UserAdminRouteDeps["persistence"]>,
  config: AppConfig,
  emailService: EmailService,
  input: { invitationId: string; token: string; inviterName?: string }
) {
  const detail = await persistence.adminQueries.invitationDetail(input.invitationId);
  if (!detail?.invitation) return { transport: "log" as const, delivered: false, error: "invitation_not_found" };
  const organizationName = await persistence.adminQueries.organizationName();
  const message = invitationEmail({
    organizationName,
    inviterName: input.inviterName,
    role: detail.invitation.role,
    acceptUrl: inviteUrl(config, input.token),
    expiresAt: new Date(detail.invitation.expiresAt)
  });
  return emailService.send({
    to: detail.invitation.email,
    subject: message.subject,
    html: message.html,
    text: message.text
  });
}

function inviteUrl(config: AppConfig, token: string) {
  return `${config.adminConsoleUrl}/invite/${encodeURIComponent(token)}`;
}

function tokenFromBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const token = (body as Record<string, unknown>).token;
  return typeof token === "string" && token.trim() ? token.trim() : undefined;
}

function sendUserAdminError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof UserAdminError)) return false;
  reply.code(error.statusCode).send({
    error: error.message,
    issues: error.issues ?? []
  });
  return true;
}

function notFound(message: string) {
  const error = new Error(message);
  (error as Error & { statusCode: number }).statusCode = 404;
  return error;
}
