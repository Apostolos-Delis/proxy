import type { FastifyInstance, FastifyReply } from "fastify";

import type { createDatabasePersistence } from "./persistence/index.js";
import { UserAdminError } from "./persistence/userAdmin.js";

type PublicInvitationRouteDeps = {
  persistence?: ReturnType<typeof createDatabasePersistence>;
};

export function registerPublicInvitationRoutes(app: FastifyInstance, deps: PublicInvitationRouteDeps) {
  const { persistence } = deps;

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
