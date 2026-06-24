import { randomBytes } from "node:crypto";

import { and, eq, gt, ne, sql } from "drizzle-orm";
import { z } from "zod";

import {
  invitations,
  organizationMembers,
  organizations,
  users,
  type ProxyTransaction,
  type ProxyTransactionalDatabase
} from "@proxy/db";
import {
  INVITATION_STATUSES,
  ORGANIZATION_MEMBER_ROLES,
  ORGANIZATION_MEMBER_STATUSES
} from "@proxy/schema";

import { createId, sha256 } from "../util.js";
import { appendAdminAuditEvent } from "./adminAudit.js";

const memberRoleSchema = z.enum([
  ORGANIZATION_MEMBER_ROLES.OWNER,
  ORGANIZATION_MEMBER_ROLES.ADMIN,
  ORGANIZATION_MEMBER_ROLES.MEMBER,
  ORGANIZATION_MEMBER_ROLES.VIEWER
]);

const createInvitationBodySchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).optional(),
  role: memberRoleSchema
}).strict();

const acceptInvitationBodySchema = z.object({
  token: z.string().trim().min(1),
  name: z.string().trim().min(1).optional()
}).strict();

const updateMemberRoleBodySchema = z.object({
  role: memberRoleSchema
}).strict();

const USER_ADMIN_PRODUCER = "proxy.admin.users";

export class UserAdminError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly issues?: { path: string; message: string }[]
  ) {
    super(message);
  }
}

export class UserAdminService {
  constructor(
    private readonly db: ProxyTransactionalDatabase,
    private readonly options: { invitationTtlSeconds: number }
  ) {}

  async createInvitation(input: {
    organizationId: string;
    actorUserId: string;
    body: unknown;
    now?: Date;
  }) {
    const body = createInvitationBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_invitation_request", body.error);
    const email = body.data.email.toLowerCase();
    const now = input.now ?? new Date();

    return this.db.transaction(async (tx) => {
      await rejectActiveMemberEmail(tx, input.organizationId, email);
      await rejectPendingInvitation(tx, input.organizationId, email, now);

      const invitationId = createId("invitation");
      const token = newInvitationToken();
      const expiresAt = new Date(now.getTime() + this.options.invitationTtlSeconds * 1000);
      await tx.insert(invitations).values({
        id: invitationId,
        organizationId: input.organizationId,
        email,
        name: body.data.name ?? null,
        role: body.data.role,
        status: INVITATION_STATUSES.PENDING,
        tokenHash: sha256(token),
        tokenPrefix: token.slice(0, 12),
        invitedByUserId: input.actorUserId,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        lastSentAt: now
      });
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "invitation",
        scopeId: invitationId,
        correlationId: invitationId,
        actorUserId: input.actorUserId,
        producer: USER_ADMIN_PRODUCER,
        eventType: "user.invitation_created",
        payload: {
          invitationId,
          email,
          role: body.data.role,
          expiresAt: expiresAt.toISOString()
        },
        createdAt: now
      });
      return { invitationId, token, expiresAt };
    });
  }

  async resendInvitation(input: {
    organizationId: string;
    actorUserId: string;
    invitationId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      const invitation = await lockedInvitationById(tx, input.organizationId, input.invitationId);
      if (!invitation) throw new UserAdminError("invitation_not_found", 404);
      if (invitation.status !== INVITATION_STATUSES.PENDING) {
        throw new UserAdminError("invitation_not_pending", 409);
      }

      const token = newInvitationToken();
      const expiresAt = new Date(now.getTime() + this.options.invitationTtlSeconds * 1000);
      await tx
        .update(invitations)
        .set({
          tokenHash: sha256(token),
          tokenPrefix: token.slice(0, 12),
          expiresAt,
          lastSentAt: now,
          updatedAt: now
        })
        .where(and(
          eq(invitations.organizationId, input.organizationId),
          eq(invitations.id, input.invitationId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "invitation",
        scopeId: input.invitationId,
        correlationId: input.invitationId,
        actorUserId: input.actorUserId,
        producer: USER_ADMIN_PRODUCER,
        eventType: "user.invitation_resent",
        payload: {
          invitationId: input.invitationId,
          email: invitation.email,
          role: invitation.role,
          expiresAt: expiresAt.toISOString()
        },
        createdAt: now
      });
      return { invitationId: input.invitationId, token, expiresAt };
    });
  }

  async revokeInvitation(input: {
    organizationId: string;
    actorUserId: string;
    invitationId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      const invitation = await lockedInvitationById(tx, input.organizationId, input.invitationId);
      if (!invitation) throw new UserAdminError("invitation_not_found", 404);
      if (invitation.status !== INVITATION_STATUSES.PENDING) {
        throw new UserAdminError("invitation_not_pending", 409);
      }

      await tx
        .update(invitations)
        .set({
          status: INVITATION_STATUSES.REVOKED,
          revokedAt: now,
          updatedAt: now
        })
        .where(and(
          eq(invitations.organizationId, input.organizationId),
          eq(invitations.id, input.invitationId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "invitation",
        scopeId: input.invitationId,
        correlationId: input.invitationId,
        actorUserId: input.actorUserId,
        producer: USER_ADMIN_PRODUCER,
        eventType: "user.invitation_revoked",
        payload: {
          invitationId: input.invitationId,
          email: invitation.email,
          role: invitation.role
        },
        createdAt: now
      });
      return { invitationId: input.invitationId };
    });
  }

  async resolveInvitation(token: string, now = new Date()) {
    const [row] = await this.db.transaction((tx) => tx
      .select({
        invitation: invitations,
        organization: organizations,
        inviter: users
      })
      .from(invitations)
      .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
      .leftJoin(users, eq(users.id, invitations.invitedByUserId))
      .where(eq(invitations.tokenHash, sha256(token)))
      .limit(1));
    if (!row) return null;

    return {
      organizationName: row.organization.name,
      email: row.invitation.email,
      name: row.invitation.name ?? undefined,
      role: row.invitation.role,
      status: effectiveInvitationStatus(row.invitation, now),
      inviterName: row.inviter?.name ?? row.inviter?.email ?? undefined,
      expiresAt: row.invitation.expiresAt.toISOString()
    };
  }

  async acceptInvitation(input: { body: unknown; now?: Date }) {
    const body = acceptInvitationBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_invitation_accept_request", body.error);
    const now = input.now ?? new Date();
    const tokenHash = sha256(body.data.token);

    return this.db.transaction(async (tx) => {
      const invitation = await lockedInvitationByTokenHash(tx, tokenHash);
      if (!invitation) throw new UserAdminError("invitation_not_found", 404);
      const status = effectiveInvitationStatus(invitation, now);
      if (status === INVITATION_STATUSES.REVOKED) throw new UserAdminError("invitation_revoked", 410);
      if (status === INVITATION_STATUSES.ACCEPTED) throw new UserAdminError("invitation_already_accepted", 409);
      if (status === "expired") throw new UserAdminError("invitation_expired", 410);

      const name = body.data.name ?? invitation.name ?? null;
      const userId = await upsertInvitedUser(tx, invitation.email, name, now);
      await upsertMembership(tx, invitation.organizationId, userId, invitation.role, now);
      await tx
        .update(invitations)
        .set({
          status: INVITATION_STATUSES.ACCEPTED,
          acceptedAt: now,
          acceptedUserId: userId,
          updatedAt: now
        })
        .where(eq(invitations.id, invitation.id));
      await appendAdminAuditEvent(tx, {
        organizationId: invitation.organizationId,
        scopeType: "invitation",
        scopeId: invitation.id,
        correlationId: invitation.id,
        actorUserId: userId,
        producer: USER_ADMIN_PRODUCER,
        eventType: "user.invitation_accepted",
        payload: {
          invitationId: invitation.id,
          userId,
          email: invitation.email,
          role: invitation.role
        },
        createdAt: now
      });
      return {
        organizationId: invitation.organizationId,
        userId,
        email: invitation.email,
        role: invitation.role
      };
    });
  }

  async updateMemberRole(input: {
    organizationId: string;
    actorUserId: string;
    userId: string;
    body: unknown;
    now?: Date;
  }) {
    const body = updateMemberRoleBodySchema.safeParse(input.body);
    if (!body.success) throw validationError("invalid_member_role_request", body.error);
    const role = body.data.role;
    const now = input.now ?? new Date();

    return this.db.transaction(async (tx) => {
      const member = await memberById(tx, input.organizationId, input.userId);
      if (!member) throw new UserAdminError("member_not_found", 404);
      if (member.role === role) return { userId: input.userId, role, previousRole: member.role };
      if (member.role === ORGANIZATION_MEMBER_ROLES.OWNER) {
        await rejectLastActiveOwner(tx, input.organizationId, input.userId);
      }

      await tx
        .update(organizationMembers)
        .set({ role, updatedAt: now })
        .where(and(
          eq(organizationMembers.organizationId, input.organizationId),
          eq(organizationMembers.userId, input.userId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "user",
        scopeId: input.userId,
        correlationId: input.userId,
        actorUserId: input.actorUserId,
        producer: USER_ADMIN_PRODUCER,
        eventType: "user.role_changed",
        payload: {
          userId: input.userId,
          previousRole: member.role,
          role
        },
        createdAt: now
      });
      return { userId: input.userId, role, previousRole: member.role };
    });
  }

  async deactivateMember(input: {
    organizationId: string;
    actorUserId: string;
    userId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      const member = await memberById(tx, input.organizationId, input.userId);
      if (!member) throw new UserAdminError("member_not_found", 404);
      if (input.userId === input.actorUserId) throw new UserAdminError("cannot_deactivate_self", 409);
      if (member.status === ORGANIZATION_MEMBER_STATUSES.DEACTIVATED) {
        throw new UserAdminError("member_already_deactivated", 409);
      }
      if (member.role === ORGANIZATION_MEMBER_ROLES.OWNER) {
        await rejectLastActiveOwner(tx, input.organizationId, input.userId);
      }

      await tx
        .update(organizationMembers)
        .set({ status: ORGANIZATION_MEMBER_STATUSES.DEACTIVATED, updatedAt: now })
        .where(and(
          eq(organizationMembers.organizationId, input.organizationId),
          eq(organizationMembers.userId, input.userId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "user",
        scopeId: input.userId,
        correlationId: input.userId,
        actorUserId: input.actorUserId,
        producer: USER_ADMIN_PRODUCER,
        eventType: "user.deactivated",
        payload: {
          userId: input.userId,
          role: member.role
        },
        createdAt: now
      });
      return { userId: input.userId, status: ORGANIZATION_MEMBER_STATUSES.DEACTIVATED };
    });
  }

  async reactivateMember(input: {
    organizationId: string;
    actorUserId: string;
    userId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    return this.db.transaction(async (tx) => {
      const member = await memberById(tx, input.organizationId, input.userId);
      if (!member) throw new UserAdminError("member_not_found", 404);
      if (member.status === ORGANIZATION_MEMBER_STATUSES.ACTIVE) {
        throw new UserAdminError("member_already_active", 409);
      }

      await tx
        .update(organizationMembers)
        .set({ status: ORGANIZATION_MEMBER_STATUSES.ACTIVE, updatedAt: now })
        .where(and(
          eq(organizationMembers.organizationId, input.organizationId),
          eq(organizationMembers.userId, input.userId)
        ));
      await appendAdminAuditEvent(tx, {
        organizationId: input.organizationId,
        scopeType: "user",
        scopeId: input.userId,
        correlationId: input.userId,
        actorUserId: input.actorUserId,
        producer: USER_ADMIN_PRODUCER,
        eventType: "user.reactivated",
        payload: {
          userId: input.userId,
          role: member.role
        },
        createdAt: now
      });
      return { userId: input.userId, status: ORGANIZATION_MEMBER_STATUSES.ACTIVE };
    });
  }
}

export function effectiveInvitationStatus(
  invitation: { status: string; expiresAt: Date },
  now = new Date()
) {
  if (invitation.status === INVITATION_STATUSES.PENDING && invitation.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return invitation.status;
}

function newInvitationToken() {
  return randomBytes(32).toString("base64url");
}

async function rejectActiveMemberEmail(tx: ProxyTransaction, organizationId: string, email: string) {
  const [member] = await tx
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.status, ORGANIZATION_MEMBER_STATUSES.ACTIVE),
      eq(users.email, email)
    ))
    .limit(1);
  if (member) throw new UserAdminError("invitation_email_already_member", 409);
}

async function rejectPendingInvitation(
  tx: ProxyTransaction,
  organizationId: string,
  email: string,
  now: Date
) {
  const [pending] = await tx
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(
      eq(invitations.organizationId, organizationId),
      eq(invitations.email, email),
      eq(invitations.status, INVITATION_STATUSES.PENDING),
      gt(invitations.expiresAt, now)
    ))
    .limit(1);
  if (pending) throw new UserAdminError("invitation_already_pending", 409);
}

async function rejectLastActiveOwner(tx: ProxyTransaction, organizationId: string, userId: string) {
  const [other] = await tx
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.role, ORGANIZATION_MEMBER_ROLES.OWNER),
      eq(organizationMembers.status, ORGANIZATION_MEMBER_STATUSES.ACTIVE),
      ne(organizationMembers.userId, userId)
    ))
    .limit(1);
  if (!other) throw new UserAdminError("last_owner", 409);
}

async function lockedInvitationById(tx: ProxyTransaction, organizationId: string, invitationId: string) {
  await tx.execute(sql`
    select id
    from invitations
    where organization_id = ${organizationId}
      and id = ${invitationId}
    for update
  `);
  const [invitation] = await tx
    .select()
    .from(invitations)
    .where(and(
      eq(invitations.organizationId, organizationId),
      eq(invitations.id, invitationId)
    ))
    .limit(1);
  return invitation ?? null;
}

async function lockedInvitationByTokenHash(tx: ProxyTransaction, tokenHash: string) {
  await tx.execute(sql`
    select id
    from invitations
    where token_hash = ${tokenHash}
    for update
  `);
  const [invitation] = await tx
    .select()
    .from(invitations)
    .where(eq(invitations.tokenHash, tokenHash))
    .limit(1);
  return invitation ?? null;
}

async function upsertInvitedUser(
  tx: ProxyTransaction,
  email: string,
  name: string | null,
  now: Date
) {
  const [existing] = await tx
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    if (name && !existing.name) {
      await tx
        .update(users)
        .set({ name, updatedAt: now })
        .where(eq(users.id, existing.id));
    }
    return existing.id;
  }

  const userId = createId("user");
  await tx.insert(users).values({
    id: userId,
    email,
    name,
    createdAt: now,
    updatedAt: now
  });
  return userId;
}

async function upsertMembership(
  tx: ProxyTransaction,
  organizationId: string,
  userId: string,
  role: typeof memberRoleSchema._output,
  now: Date
) {
  await tx
    .insert(organizationMembers)
    .values({
      organizationId,
      userId,
      role,
      status: ORGANIZATION_MEMBER_STATUSES.ACTIVE,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: {
        role,
        status: ORGANIZATION_MEMBER_STATUSES.ACTIVE,
        updatedAt: now
      }
    });
}

async function memberById(tx: ProxyTransaction, organizationId: string, userId: string) {
  const [member] = await tx
    .select()
    .from(organizationMembers)
    .where(and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.userId, userId)
    ))
    .limit(1);
  return member ?? null;
}

function validationError(message: string, error: z.ZodError) {
  return new UserAdminError(
    message,
    400,
    error.issues.map((issue) => ({
      path: issue.path.join(".") || "body",
      message: issue.message
    }))
  );
}
