import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  events,
  invitations,
  organizationMembers,
  users
} from "@prompt-proxy/db";

import { sha256 } from "../src/util.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const createInvitationMutation = `mutation CreateInvitation($input: CreateInvitationInput!) {
  createInvitation(input: $input) {
    invitation { id email name role status invitedBy { userId } }
    inviteUrl
    emailDelivery { transport delivered error }
  }
}`;

const resendInvitationMutation = `mutation ResendInvitation($invitationId: ID!) {
  resendInvitation(invitationId: $invitationId) {
    invitation { id status }
    inviteUrl
    emailDelivery { transport delivered error }
  }
}`;

const revokeInvitationMutation = `mutation RevokeInvitation($invitationId: ID!) {
  revokeInvitation(invitationId: $invitationId) { id status }
}`;

const invitationsQuery = `query {
  invitations { id email name role status tokenPrefix invitedBy { userId } }
}`;

const usersQuery = `query {
  users { userId email membership { role status } }
}`;

const updateUserRoleMutation = `mutation UpdateUserRole($userId: ID!, $role: MemberRole!) {
  updateUserRole(userId: $userId, role: $role) { userId role previousRole }
}`;

const deactivateUserMutation = `mutation DeactivateUser($userId: ID!) {
  deactivateUser(userId: $userId) { userId status }
}`;

const reactivateUserMutation = `mutation ReactivateUser($userId: ID!) {
  reactivateUser(userId: $userId) { userId status }
}`;

describe("user admin APIs", () => {
  let activeFixture: PromptTestFixture | undefined;
  let closeMock: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
    await closeMock?.();
    closeMock = undefined;
  });

  it("invites, lists, resolves, and accepts a user", async () => {
    const fixture = await setup("org_user_admin_invite");

    const created = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createInvitationMutation, {
      input: { email: "Ada@Example.com", name: "Ada Lovelace", role: "member" }
    });
    const createdBody = created.data?.createInvitation;
    const token = tokenFromInviteUrl(createdBody.inviteUrl);

    expect(created.errors).toBeUndefined();
    expect(createdBody.invitation).toEqual(expect.objectContaining({
      email: "ada@example.com",
      name: "Ada Lovelace",
      role: "member",
      status: "pending",
      invitedBy: expect.objectContaining({ userId: "local-user" })
    }));
    expect(createdBody.emailDelivery).toEqual({ transport: "log", delivered: false, error: null });
    expect(token.length).toBeGreaterThan(20);

    const duplicate = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createInvitationMutation, {
      input: { email: "ada@example.com", role: "admin" }
    });
    expect(duplicate.errors?.[0]?.message).toBe("invitation_already_pending");
    expect(duplicate.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    const memberConflict = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createInvitationMutation, {
      input: { email: "local@example.com", role: "member" }
    });
    expect(memberConflict.errors?.[0]?.message).toBe("invitation_email_already_member");
    expect(memberConflict.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    // Roles are a GraphQL enum now, so invalid values are rejected during
    // request validation before they ever reach the user admin service.
    const invalidRole = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createInvitationMutation, {
      input: { email: "valid@example.com", role: "superuser" }
    });
    expect(invalidRole.status).toBe(400);
    expect(invalidRole.errors?.[0]?.message).toContain("MemberRole");

    const list = await adminGql(fixture.proxyUrl, fixture.adminHeaders, invitationsQuery);
    const listBody = list.data?.invitations;
    const serializedList = JSON.stringify(listBody);
    expect(list.status).toBe(200);
    expect(listBody).toHaveLength(1);
    expect(serializedList).not.toContain(token);
    expect(serializedList).not.toContain(sha256(token));
    expect(serializedList).not.toContain("tokenHash");

    const resolved = await publicPost(fixture, "/api/invitations/resolve", { token });
    const resolvedBody = await resolved.json();
    expect(resolved.status).toBe(200);
    expect(resolvedBody.invitation).toEqual(expect.objectContaining({
      organizationName: "org_user_admin_invite",
      email: "ada@example.com",
      role: "member",
      status: "pending",
      inviterName: "Local User"
    }));

    const accepted = await publicPost(fixture, "/api/invitations/accept", { token, name: "Ada L" });
    const acceptedBody = await accepted.json();
    expect(accepted.status).toBe(200);
    expect(acceptedBody).toEqual(expect.objectContaining({
      ok: true,
      organizationId: "org_user_admin_invite",
      email: "ada@example.com",
      role: "member"
    }));

    const [userRow] = await fixture.db.select().from(users).where(eq(users.email, "ada@example.com"));
    const [memberRow] = await fixture.db
      .select()
      .from(organizationMembers)
      .where(and(
        eq(organizationMembers.organizationId, "org_user_admin_invite"),
        eq(organizationMembers.userId, acceptedBody.userId)
      ));
    expect(userRow).toEqual(expect.objectContaining({ id: acceptedBody.userId, name: "Ada L" }));
    expect(memberRow).toEqual(expect.objectContaining({ role: "member", status: "active" }));

    const reaccepted = await publicPost(fixture, "/api/invitations/accept", { token });
    expect(reaccepted.status).toBe(409);
    expect((await reaccepted.json()).error).toBe("invitation_already_accepted");

    const usersResult = await adminGql(fixture.proxyUrl, fixture.adminHeaders, usersQuery);
    expect(usersResult.data?.users).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: acceptedBody.userId,
        email: "ada@example.com",
        membership: { role: "member", status: "active" }
      }),
      expect.objectContaining({
        userId: "local-user",
        membership: { role: "owner", status: "active" }
      })
    ]));

    const auditEvents = await fixture.db
      .select()
      .from(events)
      .where(eq(events.scopeId, createdBody.invitation.id));
    expect(auditEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["user.invitation_created", "user.invitation_accepted"])
    );
  });

  it("rotates tokens on resend, revokes, and expires invitations", async () => {
    const fixture = await setup("org_user_admin_lifecycle");

    const first = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, createInvitationMutation, {
      input: { email: "rotate@example.com", role: "viewer" }
    })).data?.createInvitation;
    const firstToken = tokenFromInviteUrl(first.inviteUrl);

    const resent = await adminGql(fixture.proxyUrl, fixture.adminHeaders, resendInvitationMutation, {
      invitationId: first.invitation.id
    });
    const resentBody = resent.data?.resendInvitation;
    const secondToken = tokenFromInviteUrl(resentBody.inviteUrl);
    expect(resent.errors).toBeUndefined();
    expect(secondToken).not.toBe(firstToken);

    const staleResolve = await publicPost(fixture, "/api/invitations/resolve", { token: firstToken });
    expect(staleResolve.status).toBe(404);
    const staleAccept = await publicPost(fixture, "/api/invitations/accept", { token: firstToken });
    expect(staleAccept.status).toBe(404);

    const freshAccept = await publicPost(fixture, "/api/invitations/accept", { token: secondToken });
    expect(freshAccept.status).toBe(200);

    const second = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, createInvitationMutation, {
      input: { email: "revoke@example.com", role: "member" }
    })).data?.createInvitation;
    const revokeToken = tokenFromInviteUrl(second.inviteUrl);
    const revoked = await adminGql(fixture.proxyUrl, fixture.adminHeaders, revokeInvitationMutation, {
      invitationId: second.invitation.id
    });
    expect(revoked.errors).toBeUndefined();
    expect(revoked.data?.revokeInvitation.status).toBe("revoked");

    const revokedAccept = await publicPost(fixture, "/api/invitations/accept", { token: revokeToken });
    expect(revokedAccept.status).toBe(410);
    expect((await revokedAccept.json()).error).toBe("invitation_revoked");
    const revokedResend = await adminGql(fixture.proxyUrl, fixture.adminHeaders, resendInvitationMutation, {
      invitationId: second.invitation.id
    });
    expect(revokedResend.errors?.[0]?.message).toBe("invitation_not_pending");
    expect(revokedResend.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    await fixture.db.insert(invitations).values({
      id: "invitation_expired",
      organizationId: "org_user_admin_lifecycle",
      email: "late@example.com",
      role: "member",
      status: "pending",
      tokenHash: sha256("expired-token"),
      tokenPrefix: "expired-toke",
      invitedByUserId: "local-user",
      expiresAt: new Date(Date.now() - 1000)
    });
    const expiredResolve = await publicPost(fixture, "/api/invitations/resolve", { token: "expired-token" });
    expect((await expiredResolve.json()).invitation.status).toBe("expired");
    const expiredAccept = await publicPost(fixture, "/api/invitations/accept", { token: "expired-token" });
    expect(expiredAccept.status).toBe(410);
    expect((await expiredAccept.json()).error).toBe("invitation_expired");

    const renewed = await adminGql(fixture.proxyUrl, fixture.adminHeaders, resendInvitationMutation, {
      invitationId: "invitation_expired"
    });
    expect(renewed.errors).toBeUndefined();
    const renewedAccept = await publicPost(fixture, "/api/invitations/accept", {
      token: tokenFromInviteUrl(renewed.data?.resendInvitation.inviteUrl)
    });
    expect(renewedAccept.status).toBe(200);
  });

  it("changes member roles with last-owner protection", async () => {
    const fixture = await setup("org_user_admin_roles");
    const memberId = await acceptInvitedUser(fixture, "promote@example.com", "member");

    const promoted = await adminGql(fixture.proxyUrl, fixture.adminHeaders, updateUserRoleMutation, {
      userId: memberId,
      role: "admin"
    });
    expect(promoted.errors).toBeUndefined();
    expect(promoted.data?.updateUserRole).toEqual({ userId: memberId, role: "admin", previousRole: "member" });

    const lastOwner = await adminGql(fixture.proxyUrl, fixture.adminHeaders, updateUserRoleMutation, {
      userId: "local-user",
      role: "member"
    });
    expect(lastOwner.errors?.[0]?.message).toBe("last_owner");
    expect(lastOwner.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    // Invalid roles are rejected by GraphQL enum validation before execution.
    const invalidRole = await adminGql(fixture.proxyUrl, fixture.adminHeaders, updateUserRoleMutation, {
      userId: memberId,
      role: "root"
    });
    expect(invalidRole.status).toBe(400);
    expect(invalidRole.errors?.[0]?.message).toContain("MemberRole");

    const missingMember = await adminGql(fixture.proxyUrl, fixture.adminHeaders, updateUserRoleMutation, {
      userId: "unknown-user",
      role: "member"
    });
    expect(missingMember.errors?.[0]?.message).toBe("member_not_found");
    expect(missingMember.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");

    const roleEvents = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "user.role_changed"));
    expect(roleEvents).toEqual([
      expect.objectContaining({
        scopeType: "user",
        scopeId: memberId,
        actorId: "local-user",
        payload: expect.objectContaining({ previousRole: "member", role: "admin" })
      })
    ]);
  });

  it("deactivates and reactivates members with guards", async () => {
    const fixture = await setup("org_user_admin_status");
    const memberId = await acceptInvitedUser(fixture, "pause@example.com", "member");

    const session = await fixture.persistence.adminSessions.create({
      organizationId: "org_user_admin_status",
      userId: memberId,
      ttlSeconds: 3600
    });
    expect(session).not.toBeNull();

    const selfDeactivate = await adminGql(fixture.proxyUrl, fixture.adminHeaders, deactivateUserMutation, {
      userId: "local-user"
    });
    expect(selfDeactivate.errors?.[0]?.message).toBe("cannot_deactivate_self");
    expect(selfDeactivate.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    const deactivated = await adminGql(fixture.proxyUrl, fixture.adminHeaders, deactivateUserMutation, {
      userId: memberId
    });
    expect(deactivated.errors).toBeUndefined();
    expect(deactivated.data?.deactivateUser).toEqual({ userId: memberId, status: "deactivated" });
    expect(await fixture.persistence.adminSessions.resolve(session?.token ?? "")).toBeNull();

    const repeated = await adminGql(fixture.proxyUrl, fixture.adminHeaders, deactivateUserMutation, {
      userId: memberId
    });
    expect(repeated.errors?.[0]?.message).toBe("member_already_deactivated");
    expect(repeated.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    const usersResult = await adminGql(fixture.proxyUrl, fixture.adminHeaders, usersQuery);
    expect(usersResult.data?.users).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: memberId,
        membership: { role: "member", status: "deactivated" }
      })
    ]));

    const reactivated = await adminGql(fixture.proxyUrl, fixture.adminHeaders, reactivateUserMutation, {
      userId: memberId
    });
    expect(reactivated.errors).toBeUndefined();
    expect(reactivated.data?.reactivateUser).toEqual({ userId: memberId, status: "active" });
    const reactivatedAgain = await adminGql(fixture.proxyUrl, fixture.adminHeaders, reactivateUserMutation, {
      userId: memberId
    });
    expect(reactivatedAgain.errors?.[0]?.message).toBe("member_already_active");
    expect(reactivatedAgain.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    const ownerId = await acceptInvitedUser(fixture, "owner2@example.com", "owner");
    await fixture.db
      .update(organizationMembers)
      .set({ role: "admin" })
      .where(and(
        eq(organizationMembers.organizationId, "org_user_admin_status"),
        eq(organizationMembers.userId, "local-user")
      ));
    const lastOwner = await adminGql(fixture.proxyUrl, fixture.adminHeaders, deactivateUserMutation, {
      userId: ownerId
    });
    expect(lastOwner.errors?.[0]?.message).toBe("last_owner");
    expect(lastOwner.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    const statusEvents = await fixture.db
      .select()
      .from(events)
      .where(eq(events.scopeId, memberId));
    expect(statusEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["user.deactivated", "user.reactivated"])
    );
  });

  it("delivers invitation email through the resend transport", async () => {
    const resendMock = await startResendMock();
    closeMock = resendMock.close;
    const fixture = await setup("org_user_admin_email", {
      RESEND_API_KEY: "test-resend-key",
      RESEND_BASE_URL: resendMock.url,
      EMAIL_FROM: "Prompt Proxy <invites@example.com>",
      ADMIN_CONSOLE_URL: "https://console.example.com"
    });

    const created = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createInvitationMutation, {
      input: { email: "mail@example.com", name: "Mail Person", role: "admin" }
    });
    const createdBody = created.data?.createInvitation;

    expect(created.errors).toBeUndefined();
    expect(createdBody.emailDelivery).toEqual({ transport: "resend", delivered: true, error: null });
    expect(createdBody.inviteUrl.startsWith("https://console.example.com/invite/")).toBe(true);
    expect(resendMock.records).toHaveLength(1);
    expect(resendMock.records[0].headers.authorization).toBe("Bearer test-resend-key");
    expect(resendMock.records[0].body).toEqual(expect.objectContaining({
      from: "Prompt Proxy <invites@example.com>",
      to: ["mail@example.com"],
      subject: "You're invited to join org_user_admin_email on Prompt Proxy"
    }));
    expect(resendMock.records[0].body.html).toContain(createdBody.inviteUrl);
    expect(resendMock.records[0].body.text).toContain(createdBody.inviteUrl);

    resendMock.failNext(500);
    const failed = await adminGql(fixture.proxyUrl, fixture.adminHeaders, createInvitationMutation, {
      input: { email: "mail-two@example.com", role: "member" }
    });
    expect(failed.errors).toBeUndefined();
    expect(failed.data?.createInvitation.emailDelivery).toEqual({
      transport: "resend",
      delivered: false,
      error: "resend_status_500"
    });
  });

  async function setup(organizationId: string, envOverrides: NodeJS.ProcessEnv = {}) {
    const fixture = await captureFixture(organizationId, "raw_text", false, {
      envOverrides: {
        RESEND_API_KEY: "",
        ...envOverrides
      }
    });
    activeFixture = fixture;
    return fixture;
  }
});

async function acceptInvitedUser(fixture: PromptTestFixture, email: string, role: string) {
  const created = (await adminGql(fixture.proxyUrl, fixture.adminHeaders, createInvitationMutation, {
    input: { email, role }
  })).data?.createInvitation;
  const accepted = await publicPost(fixture, "/api/invitations/accept", {
    token: tokenFromInviteUrl(created.inviteUrl)
  });
  expect(accepted.status).toBe(200);
  const body = await accepted.json();
  return body.userId as string;
}

function publicPost(fixture: PromptTestFixture, path: string, body: unknown) {
  return fetch(`${fixture.proxyUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function tokenFromInviteUrl(inviteUrl: string) {
  const [, token] = inviteUrl.split("/invite/");
  expect(token).toBeTruthy();
  return decodeURIComponent(token);
}

async function startResendMock() {
  const records: { headers: Record<string, string | string[] | undefined>; body: any }[] = [];
  let nextStatus: number | undefined;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      records.push({ headers: request.headers, body: raw ? JSON.parse(raw) : {} });
      const status = nextStatus ?? 200;
      nextStatus = undefined;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(status === 200 ? { id: "email_mock" } : { error: "mock_failure" }));
    });
  });

  return new Promise<{
    url: string;
    records: typeof records;
    failNext: (status: number) => void;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        records,
        failNext: (status: number) => {
          nextStatus = status;
        },
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}
