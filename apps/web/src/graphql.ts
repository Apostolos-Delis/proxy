import type { TypedDocumentString } from "./gql/graphql";

const apiBase = import.meta.env.VITE_PROMPT_PROXY_API_BASE ?? "http://127.0.0.1:8787";

type GraphQLErrorPayload = {
  message: string;
  extensions?: {
    code?: string;
    issues?: { path?: unknown; message?: unknown }[];
  };
};

export async function gqlFetch<TResult, TVariables>(
  document: TypedDocumentString<TResult, TVariables>,
  ...[variables]: TVariables extends Record<string, never> ? [] : [TVariables]
): Promise<TResult> {
  const response = await fetch(`${apiBase}/admin/graphql`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ query: document.toString(), variables })
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as {
    data?: TResult;
    errors?: GraphQLErrorPayload[];
  };
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(formatGraphQLError(payload.errors[0]));
  }
  if (payload.data === undefined || payload.data === null) {
    throw new Error("GraphQL response contained no data.");
  }
  return payload.data;
}

function formatGraphQLError(error: GraphQLErrorPayload) {
  const issues = Array.isArray(error.extensions?.issues)
    ? error.extensions.issues
      .map((issue) => {
        if (typeof issue.message !== "string") return null;
        const path = typeof issue.path === "string" ? `${issue.path}: ` : "";
        return `${path}${issue.message}`;
      })
      .filter((issue): issue is string => Boolean(issue))
    : [];
  return issues.length > 0 ? `${error.message} (${issues.join("; ")})` : error.message;
}
