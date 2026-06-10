import type { AppConfig } from "./config.js";

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type EmailDeliveryResult = {
  transport: "resend" | "log";
  delivered: boolean;
  error?: string;
};

export type EmailLogger = {
  info: (payload: Record<string, unknown>, message: string) => void;
  error: (payload: Record<string, unknown>, message: string) => void;
};

export class EmailService {
  constructor(
    private readonly config: Pick<AppConfig, "resendApiKey" | "resendBaseUrl" | "emailFrom">,
    private readonly logger: EmailLogger
  ) {}

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    if (!this.config.resendApiKey) {
      this.logger.info(
        { to: message.to, subject: message.subject },
        "email transport disabled; logging message instead of sending"
      );
      return { transport: "log", delivered: false };
    }

    try {
      const response = await fetch(`${this.config.resendBaseUrl}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.resendApiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          from: this.config.emailFrom,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text
        })
      });
      if (!response.ok) {
        const error = `resend_status_${response.status}`;
        this.logger.error(
          { to: message.to, subject: message.subject, statusCode: response.status },
          "email delivery failed"
        );
        return { transport: "resend", delivered: false, error };
      }
      return { transport: "resend", delivered: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "resend_request_failed";
      this.logger.error({ to: message.to, subject: message.subject, error: reason }, "email delivery failed");
      return { transport: "resend", delivered: false, error: reason };
    }
  }
}
