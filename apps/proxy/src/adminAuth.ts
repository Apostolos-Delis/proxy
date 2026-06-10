import type { AppConfig } from "./config.js";
import type { AdminSessionStore } from "./persistence/adminSessions.js";
import { headerValue } from "./util.js";

export class AdminAuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly sessions?: AdminSessionStore
  ) {}

  async login(body: unknown) {
    if (!this.config.adminDevLoginEnabled || !this.sessions) throw forbidden();
    const credentials = loginCredentials(body);
    if (
      credentials.email !== this.config.adminDevLoginEmail ||
      credentials.password !== this.config.adminDevLoginPassword
    ) {
      throw unauthorized();
    }

    const session = await this.sessions.create({
      organizationId: this.config.defaultOrganizationId,
      userId: this.config.seedUserId,
      ttlSeconds: this.config.adminSessionTtlSeconds
    });
    if (!session) throw unauthorized();
    return session;
  }

  async resolve(headers: Record<string, unknown>) {
    const token = this.token(headers);
    if (!token || !this.sessions) throw unauthorized();
    const identity = await this.sessions.resolve(token);
    if (!identity) throw unauthorized();
    return identity;
  }

  async switchOrganization(headers: Record<string, unknown>, body: unknown) {
    const identity = await this.resolve(headers);
    if (!this.sessions) throw forbidden();
    const session = await this.sessions.create({
      organizationId: switchOrganizationTarget(body),
      userId: identity.userId,
      ttlSeconds: this.config.adminSessionTtlSeconds
    });
    if (!session) throw forbidden();
    const token = this.token(headers);
    if (token) await this.sessions.revoke(token);
    return session;
  }

  async logout(headers: Record<string, unknown>) {
    const token = this.token(headers);
    if (token && this.sessions) await this.sessions.revoke(token);
  }

  token(headers: Record<string, unknown>) {
    return cookieValue(headers, this.config.adminSessionCookieName);
  }

  sessionCookie(token: string, expiresAt: Date) {
    return [
      `${this.config.adminSessionCookieName}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Expires=${expiresAt.toUTCString()}`
    ].join("; ");
  }

  clearCookie() {
    return [
      `${this.config.adminSessionCookieName}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0"
    ].join("; ");
  }
}

function loginCredentials(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw unauthorized();
  const record = body as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim() : "";
  const password = typeof record.password === "string" ? record.password : "";
  if (!email || !password) throw unauthorized();
  return { email, password };
}

function switchOrganizationTarget(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest();
  const organizationId = (body as Record<string, unknown>).organizationId;
  if (typeof organizationId !== "string" || !organizationId.trim()) throw badRequest();
  return organizationId.trim();
}

function cookieValue(headers: Record<string, unknown>, name: string) {
  const raw = headerValue(headers, "cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function unauthorized() {
  const error = new Error("Unauthorized");
  (error as Error & { statusCode: number }).statusCode = 401;
  return error;
}

function forbidden() {
  const error = new Error("Forbidden");
  (error as Error & { statusCode: number }).statusCode = 403;
  return error;
}

function badRequest() {
  const error = new Error("organization_id_required");
  (error as Error & { statusCode: number }).statusCode = 400;
  return error;
}
