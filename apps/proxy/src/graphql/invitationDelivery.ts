import type { AppConfig } from "../config.js";
import type { EmailService } from "../email.js";
import { invitationEmail } from "../emailTemplates.js";
import type { InvitationModel } from "./models.js";
import type { ScopedAdminQueries } from "./context.js";

export async function sendInvitationEmail(
  queries: ScopedAdminQueries,
  config: AppConfig,
  emailService: EmailService,
  input: { invitation: InvitationModel | null; token: string; inviterName?: string }
) {
  if (!input.invitation) return { transport: "log" as const, delivered: false, error: "invitation_not_found" };
  const organizationName = await queries.organizationName();
  const message = invitationEmail({
    organizationName,
    inviterName: input.inviterName,
    role: input.invitation.role,
    acceptUrl: inviteUrl(config, input.token),
    expiresAt: new Date(input.invitation.expiresAt)
  });
  return emailService.send({
    to: input.invitation.email,
    subject: message.subject,
    html: message.html,
    text: message.text
  });
}

export function inviteUrl(config: AppConfig, token: string) {
  return `${config.adminConsoleUrl}/invite/${encodeURIComponent(token)}`;
}
