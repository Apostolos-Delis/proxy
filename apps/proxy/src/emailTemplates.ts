const palette = {
  background: "#f1f3f5",
  card: "#ffffff",
  border: "#e3e6ea",
  header: "#0c1116",
  headerText: "#f8fafc",
  accent: "#14b8a6",
  accentDark: "#0f766e",
  text: "#1f2937",
  muted: "#6b7280"
};

export type InvitationEmailInput = {
  organizationName: string;
  inviterName?: string;
  role: string;
  acceptUrl: string;
  expiresAt: Date;
};

export function invitationEmail(input: InvitationEmailInput) {
  const inviter = input.inviterName?.trim() || "An administrator";
  const expires = formatExpiry(input.expiresAt);
  const subject = `You're invited to join ${input.organizationName} on Proxy`;
  const heading = `Join ${input.organizationName}`;
  const intro = `${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(input.organizationName)}</strong> on Proxy as ${roleLabel(input.role)}.`;
  const html = emailLayout({
    preheader: `${inviter} invited you to join ${input.organizationName} on Proxy.`,
    heading,
    bodyHtml: `
      <p style="margin: 0 0 12px; color: ${palette.text}; font-size: 15px; line-height: 24px;">${intro}</p>
      <p style="margin: 0 0 28px; color: ${palette.muted}; font-size: 14px; line-height: 22px;">
        Proxy is the operations console for model routing, usage, and prompt observability.
        Accept the invitation to activate your membership.
      </p>`,
    cta: { label: "Accept invitation", url: input.acceptUrl },
    footerNote: `This invitation expires on ${expires}. If you weren't expecting it, you can safely ignore this email.`
  });
  const text = [
    `You're invited to join ${input.organizationName} on Proxy`,
    "",
    `${inviter} invited you to join ${input.organizationName} as ${roleLabel(input.role)}.`,
    "",
    `Accept the invitation: ${input.acceptUrl}`,
    "",
    `This invitation expires on ${expires}. If you weren't expecting it, you can safely ignore this email.`
  ].join("\n");

  return { subject, html, text };
}

export function emailLayout(input: {
  preheader: string;
  heading: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  footerNote: string;
}) {
  const cta = input.cta
    ? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 8px;">
              <tr>
                <td style="border-radius: 7px; background: ${palette.accent};">
                  <a href="${escapeAttribute(input.cta.url)}"
                     style="display: inline-block; padding: 12px 28px; font-family: ${fontStack}; font-size: 15px; font-weight: 600; color: #04211d; text-decoration: none; border-radius: 7px;">
                    ${escapeHtml(input.cta.label)}
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin: 16px 0 0; color: ${palette.muted}; font-size: 12px; line-height: 18px; word-break: break-all;">
              Or paste this link into your browser:<br />
              <a href="${escapeAttribute(input.cta.url)}" style="color: ${palette.accentDark}; text-decoration: underline;">${escapeHtml(input.cta.url)}</a>
            </p>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.heading)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: ${palette.background};">
    <div style="display: none; max-height: 0; overflow: hidden;">${escapeHtml(input.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: ${palette.background}; padding: 32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%;">
            <tr>
              <td style="background: ${palette.header}; border-radius: 8px 8px 0 0; padding: 20px 32px;">
                <span style="font-family: ${fontStack}; font-size: 15px; font-weight: 700; letter-spacing: 0.4px; color: ${palette.headerText};">
                  <span style="color: ${palette.accent};">&#9670;</span>&nbsp; Proxy
                </span>
              </td>
            </tr>
            <tr>
              <td style="background: ${palette.card}; border: 1px solid ${palette.border}; border-top: 0; border-radius: 0 0 8px 8px; padding: 32px;">
                <h1 style="margin: 0 0 16px; font-family: ${fontStack}; font-size: 20px; line-height: 28px; color: ${palette.text};">${escapeHtml(input.heading)}</h1>
                <div style="font-family: ${fontStack};">${input.bodyHtml}</div>
                ${cta}
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 32px;">
                <p style="margin: 0; font-family: ${fontStack}; font-size: 12px; line-height: 18px; color: ${palette.muted};">
                  ${escapeHtml(input.footerNote)}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const fontStack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function roleLabel(role: string) {
  if (role === "owner" || role === "admin") return `an ${role}`;
  return `a ${role}`;
}

function formatExpiry(expiresAt: Date) {
  return expiresAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
