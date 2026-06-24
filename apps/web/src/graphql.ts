import type { TypedDocumentString } from "./gql/graphql";

export const apiBase = import.meta.env.VITE_PROXY_API_BASE ?? "http://127.0.0.1:8787";
export const adminApiBase = import.meta.env.DEV ? "" : apiBase;
const GRAPHQL_CACHE_SCOPE_PARAM = "gqlCacheScope";
const GRAPHQL_CACHE_EPOCH_PARAM = "gqlCacheEpoch";
const GRAPHQL_CACHE_EPOCH_STORAGE_KEY = "prompt:gql-cache-epoch";
const MAX_GRAPHQL_GET_URL_LENGTH = 7_500;
type GraphQLOperationType = "query" | "mutation" | "subscription" | "unknown";

let graphQLCacheScope: string | null = null;
let graphQLCacheScopeIdentity: string | null = null;
let graphQLCacheEpoch = readStoredCacheEpoch();

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
  const query = document.toString();
  const operationType = graphQLOperationType(query);
  const request = graphQLRequest(query, variables, operationType);
  const response = await fetch(request.url, request.init);
  const payload = await response.json().catch(() => null) as {
    data?: TResult;
    errors?: GraphQLErrorPayload[];
  } | null;
  if (payload?.errors && payload.errors.length > 0) {
    throw new Error(formatGraphQLError(payload.errors[0]));
  }
  if (!response.ok || !payload) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  if (payload.data === undefined || payload.data === null) {
    throw new Error("GraphQL response contained no data.");
  }
  if (operationType === "mutation") bumpGraphQLCacheEpoch();
  return payload.data;
}

export function setGraphQLCacheScope(value: string | null) {
  if (value === null) {
    graphQLCacheScopeIdentity = null;
    graphQLCacheScope = null;
    return;
  }
  if (value !== graphQLCacheScopeIdentity || !graphQLCacheScope) {
    graphQLCacheScopeIdentity = value;
    graphQLCacheScope = randomGraphQLCacheScope();
  }
}

export function bumpGraphQLCacheEpoch() {
  graphQLCacheEpoch = currentGraphQLCacheEpoch() + 1;
  writeStoredCacheEpoch(graphQLCacheEpoch);
}

function graphQLRequest<TVariables>(
  query: string,
  variables: TVariables | undefined,
  operationType: GraphQLOperationType
): { url: string; init: RequestInit } {
  const endpoint = `${adminApiBase}/admin/graphql`;
  if (operationType === "query" && graphQLCacheScope) {
    const url = graphQLGetUrl(endpoint, query, variables);
    if (url.length <= MAX_GRAPHQL_GET_URL_LENGTH) {
      return {
        url,
        init: {
          method: "GET",
          credentials: "include" as const,
          headers: { accept: "application/json" }
        }
      };
    }
  }
  return {
    url: endpoint,
    init: {
      method: "POST",
      credentials: "include" as const,
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ query, variables })
    }
  };
}

function graphQLGetUrl<TVariables>(endpoint: string, query: string, variables: TVariables | undefined) {
  const params = new URLSearchParams();
  params.set("query", query);
  if (variables !== undefined) params.set("variables", JSON.stringify(variables));
  params.set(GRAPHQL_CACHE_SCOPE_PARAM, graphQLCacheScope ?? "");
  params.set(GRAPHQL_CACHE_EPOCH_PARAM, String(currentGraphQLCacheEpoch()));
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${params.toString()}`;
}

function graphQLOperationType(query: string): GraphQLOperationType {
  const match = /^\s*(query|mutation|subscription)\b/.exec(query);
  if (match?.[1] === "query" || match?.[1] === "mutation" || match?.[1] === "subscription") {
    return match[1];
  }
  return "unknown";
}

function currentGraphQLCacheEpoch() {
  const stored = readStoredCacheEpoch();
  if (stored > graphQLCacheEpoch) graphQLCacheEpoch = stored;
  return graphQLCacheEpoch;
}

function randomGraphQLCacheScope() {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

function readStoredCacheEpoch() {
  try {
    if (typeof window === "undefined") return 0;
    const value = Number(window.localStorage.getItem(GRAPHQL_CACHE_EPOCH_STORAGE_KEY));
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeStoredCacheEpoch(value: number) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(GRAPHQL_CACHE_EPOCH_STORAGE_KEY, String(value));
  } catch {
    return;
  }
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
