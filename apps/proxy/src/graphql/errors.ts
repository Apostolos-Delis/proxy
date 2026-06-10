import { createGraphQLError } from "graphql-yoga";

import { AdminMutationError } from "../persistence/adminErrors.js";
import { UserAdminError } from "../persistence/userAdmin.js";

const CODES: Record<number, string> = {
  400: "BAD_USER_INPUT",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  410: "GONE"
};

// Drives the same HTTP 401 the REST endpoints returned, so the console's
// redirect-to-login path and status assertions keep working unchanged.
export function unauthenticatedError() {
  return createGraphQLError("Unauthorized", {
    extensions: {
      code: "UNAUTHENTICATED",
      http: { status: 401 }
    }
  });
}

function codeForStatus(statusCode: number) {
  return CODES[statusCode] ?? "INTERNAL_SERVER_ERROR";
}

export function adminGraphQLError(message: string, statusCode: number, issues?: unknown) {
  return createGraphQLError(message, {
    extensions: {
      code: codeForStatus(statusCode),
      issues: issues ?? []
    }
  });
}

export function notFoundError(message: string) {
  return adminGraphQLError(message, 404);
}

export function mapAdminError(error: unknown): never {
  if (error instanceof AdminMutationError || error instanceof UserAdminError) {
    throw adminGraphQLError(error.message, error.statusCode, error.issues);
  }
  if (error instanceof Error && typeof (error as { statusCode?: unknown }).statusCode === "number") {
    throw adminGraphQLError(error.message, (error as Error & { statusCode: number }).statusCode);
  }
  throw error;
}
