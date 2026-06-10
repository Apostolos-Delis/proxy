import { graphql } from "./gql";
import type { ViewerQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";

export const apiBase = import.meta.env.VITE_PROMPT_PROXY_API_BASE ?? "http://127.0.0.1:8787";

// Session bootstrap and the public invitation flow stay on REST: they set or
// clear cookies, or are reachable without an admin session. Everything else
// lives in the GraphQL API (see ./graphql.ts and per-page documents).

export type AuthMe = ViewerQuery["viewer"];

export type PublicInvitation = {
  organizationName: string;
  email: string;
  name?: string;
  role: string;
  status: string;
  inviterName?: string;
  expiresAt: string;
};

const ViewerDocument = graphql(`
  query Viewer {
    viewer {
      user {
        sessionId
        organizationId
        userId
        email
        name
        role
      }
      organizationId
      organizations {
        id
        slug
        name
        role
      }
    }
  }
`);

export async function fetchMe(): Promise<AuthMe> {
  const result = await gqlFetch(ViewerDocument);
  return result.viewer;
}

export async function login(email: string, password: string) {
  return fetchJson<AuthMe>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
}

export async function switchOrganization(organizationId: string) {
  return fetchJson<AuthMe>("/api/auth/switch-organization", {
    method: "POST",
    body: JSON.stringify({ organizationId })
  });
}

export async function logout() {
  return fetchJson<{ ok: boolean }>("/api/auth/logout", {
    method: "POST"
  });
}

export async function resolveInvitation(token: string) {
  return fetchJson<{ invitation: PublicInvitation }>("/api/invitations/resolve", {
    method: "POST",
    body: JSON.stringify({ token })
  });
}

export async function acceptInvitation(token: string, name?: string) {
  return fetchJson<{ ok: boolean; organizationId: string; userId: string; email: string; role: string }>(
    "/api/invitations/accept",
    {
      method: "POST",
      body: JSON.stringify(name ? { token, name } : { token })
    }
  );
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

async function responseErrorMessage(response: Response) {
  const fallback = `${response.status} ${response.statusText}`;
  const body = await response.json().catch(() => null) as {
    error?: unknown;
    issues?: { path?: unknown; message?: unknown }[];
  } | null;
  if (typeof body?.error !== "string") return fallback;

  const issues = Array.isArray(body.issues)
    ? body.issues
      .map((issue) => {
        if (typeof issue.message !== "string") return null;
        const path = typeof issue.path === "string" ? `${issue.path}: ` : "";
        return `${path}${issue.message}`;
      })
      .filter((issue): issue is string => Boolean(issue))
    : [];
  return issues.length > 0 ? `${body.error} (${issues.join("; ")})` : body.error;
}
