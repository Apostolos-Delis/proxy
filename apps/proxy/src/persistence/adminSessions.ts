import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  organizationMembers,
  userSessions,
  users,
  type PromptProxyDbSession
} from "@prompt-proxy/db";

import { createId, sha256 } from "../util.js";

export type AdminSessionIdentity = {
  sessionId: string;
  organizationId: string;
  userId: string;
  email?: string;
  name?: string;
  role: string;
};

export class AdminSessionStore {
  constructor(private readonly db: PromptProxyDbSession) {}

  async create(input: {
    organizationId: string;
    userId: string;
    ttlSeconds: number;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const member = await this.activeMember(input.organizationId, input.userId);
    if (!member) return null;

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    const sessionId = createId("admin_session");
    await this.db.insert(userSessions).values({
      id: sessionId,
      organizationId: input.organizationId,
      userId: input.userId,
      sessionTokenHash: sha256(token),
      sessionTokenPrefix: token.slice(0, 12),
      createdAt: now,
      expiresAt
    });

    return {
      token,
      expiresAt,
      identity: {
        sessionId,
        organizationId: input.organizationId,
        userId: input.userId,
        email: member.user.email ?? undefined,
        name: member.user.name ?? undefined,
        role: member.member.role
      }
    };
  }

  async resolve(token: string, now = new Date()) {
    const [row] = await this.db
      .select({
        session: userSessions,
        user: users,
        member: organizationMembers
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .innerJoin(organizationMembers, and(
        eq(organizationMembers.organizationId, userSessions.organizationId),
        eq(organizationMembers.userId, userSessions.userId)
      ))
      .where(eq(userSessions.sessionTokenHash, sha256(token)))
      .limit(1);
    if (!row) return null;
    if (row.session.revokedAt) return null;
    if (row.session.expiresAt.getTime() <= now.getTime()) return null;
    if (row.member.status !== "active") return null;

    await this.db
      .update(userSessions)
      .set({ lastSeenAt: now })
      .where(eq(userSessions.id, row.session.id));

    return {
      sessionId: row.session.id,
      organizationId: row.session.organizationId,
      userId: row.session.userId,
      email: row.user.email ?? undefined,
      name: row.user.name ?? undefined,
      role: row.member.role
    };
  }

  async revoke(token: string, now = new Date()) {
    await this.db
      .update(userSessions)
      .set({ revokedAt: now })
      .where(eq(userSessions.sessionTokenHash, sha256(token)));
  }

  private async activeMember(organizationId: string, userId: string) {
    const [row] = await this.db
      .select({
        user: users,
        member: organizationMembers
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.status, "active")
      ))
      .limit(1);
    return row ?? null;
  }
}
