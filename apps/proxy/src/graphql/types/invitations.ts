import type { EmailService } from "../../email.js";
import type { UserAdminService } from "../../persistence/userAdmin.js";
import { builder } from "../builder.js";
import type { InvitationInviterModel, InvitationModel } from "../models.js";

export type EmailDeliveryModel = Awaited<ReturnType<EmailService["send"]>>;
export type InvitationActionResultModel = {
  invitation: InvitationModel | null;
  inviteUrl: string;
  emailDelivery: EmailDeliveryModel;
};
export type UpdateUserRoleResultModel = Awaited<ReturnType<UserAdminService["updateMemberRole"]>>;
export type UserStatusResultModel =
  | Awaited<ReturnType<UserAdminService["deactivateMember"]>>
  | Awaited<ReturnType<UserAdminService["reactivateMember"]>>;

export const InvitationInviter = builder
  .objectRef<InvitationInviterModel>("InvitationInviter")
  .implement({
    fields: (t) => ({
      userId: t.exposeString("userId"),
      name: t.exposeString("name", { nullable: true }),
      email: t.exposeString("email", { nullable: true })
    })
  });

export const Invitation = builder.objectRef<InvitationModel>("Invitation").implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    organizationId: t.exposeString("organizationId"),
    email: t.exposeString("email"),
    name: t.exposeString("name", { nullable: true }),
    role: t.exposeString("role"),
    status: t.exposeString("status"),
    tokenPrefix: t.exposeString("tokenPrefix"),
    invitedBy: t.field({
      type: InvitationInviter,
      nullable: true,
      resolve: (invitation) => invitation.invitedBy
    }),
    acceptedUserId: t.exposeString("acceptedUserId", { nullable: true }),
    createdAt: t.exposeString("createdAt"),
    expiresAt: t.exposeString("expiresAt"),
    lastSentAt: t.exposeString("lastSentAt", { nullable: true }),
    acceptedAt: t.exposeString("acceptedAt", { nullable: true }),
    revokedAt: t.exposeString("revokedAt", { nullable: true })
  })
});

export const EmailDelivery = builder.objectRef<EmailDeliveryModel>("EmailDelivery").implement({
  fields: (t) => ({
    transport: t.exposeString("transport"),
    delivered: t.exposeBoolean("delivered"),
    error: t.exposeString("error", { nullable: true })
  })
});

export const InvitationActionResult = builder
  .objectRef<InvitationActionResultModel>("InvitationActionResult")
  .implement({
    fields: (t) => ({
      invitation: t.field({
        type: Invitation,
        nullable: true,
        resolve: (result) => result.invitation
      }),
      inviteUrl: t.exposeString("inviteUrl"),
      emailDelivery: t.expose("emailDelivery", { type: EmailDelivery })
    })
  });

export const UpdateUserRoleResult = builder
  .objectRef<UpdateUserRoleResultModel>("UpdateUserRoleResult")
  .implement({
    fields: (t) => ({
      userId: t.exposeString("userId"),
      role: t.exposeString("role"),
      previousRole: t.exposeString("previousRole")
    })
  });

export const UserStatusResult = builder
  .objectRef<UserStatusResultModel>("UserStatusResult")
  .implement({
    fields: (t) => ({
      userId: t.exposeString("userId"),
      status: t.exposeString("status")
    })
  });
