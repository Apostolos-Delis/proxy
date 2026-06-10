import type { AppConfig } from "../config.js";
import type { EmailService } from "../email.js";
import { invitationEmail } from "../emailTemplates.js";
import type { AppPersistence } from "./context.js";

export async function sendInvitationEmail(
  persistence: AppPersistence,
  config: AppConfig,
  emailService: EmailService,
  input: { organizationId: string; invitationId: string; token: string; inviterName?: string }
) {
  const adminQueries = persistence.adminQueries.forOrg(input.organizationId);
  const detail = await adminQueries.invitationDetail(input.invitationId);
  if (!detail?.invitation) return { transport: "log" as const, delivered: false, error: "invitation_not_found" };
  const organizationName = await adminQueries.organizationName();
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

export function inviteUrl(config: AppConfig, token: string) {
  return `${config.adminConsoleUrl}/invite/${encodeURIComponent(token)}`;
}
