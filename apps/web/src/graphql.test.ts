import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireAuth } from "./auth";
import { TypedDocumentString } from "./gql/graphql";
import { bumpGraphQLCacheEpoch, gqlFetch, setGraphQLCacheScope } from "./graphql";
import { stopLiveUpdates } from "./liveUpdates";
import type { AuthMe } from "./session";

const QueryDocument = new TypedDocumentString<{ ok: boolean }, { id: string }>(`
  query TestQuery($id: ID!) {
    ok(id: $id)
  }
`);

const MutationDocument = new TypedDocumentString<{ ok: boolean }, { id: string }>(`
  mutation TestMutation($id: ID!) {
    ok(id: $id)
  }
`);

class FakeEventSource {
  readyState = 1;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
  }

  close() {
    this.readyState = 2;
  }
}

describe("gqlFetch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setGraphQLCacheScope(null);
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), {
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    stopLiveUpdates();
    setGraphQLCacheScope(null);
    vi.unstubAllGlobals();
  });

  it("uses POST before an auth cache scope is known", async () => {
    await gqlFetch(QueryDocument, { id: "one" });
    const [, init] = fetchMock.mock.calls[0];

    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).variables).toEqual({ id: "one" });
  });

  it("uses scoped GET for queries after auth cache scope is known", async () => {
    setGraphQLCacheScope("session:org:workspace");

    await gqlFetch(QueryDocument, { id: "one" });
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), "http://localhost");

    expect(init.method).toBe("GET");
    expect(parsed.pathname).toBe("/admin/graphql");
    expect(parsed.searchParams.get("variables")).toBe(JSON.stringify({ id: "one" }));
    expect(parsed.searchParams.get("gqlCacheScope")).toBeTruthy();
    expect(parsed.searchParams.get("gqlCacheScope")).not.toBe("session:org:workspace");
    expect(parsed.searchParams.get("gqlCacheEpoch")).toMatch(/^\d+$/);
  });

  it("keeps mutations on POST and advances the cache epoch for later queries", async () => {
    setGraphQLCacheScope("session:org:workspace");

    await gqlFetch(QueryDocument, { id: "one" });
    const firstEpoch = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost").searchParams.get("gqlCacheEpoch");
    await gqlFetch(MutationDocument, { id: "one" });
    await gqlFetch(QueryDocument, { id: "one" });

    const [, mutationInit] = fetchMock.mock.calls[1];
    const nextEpoch = new URL(String(fetchMock.mock.calls[2][0]), "http://localhost").searchParams.get("gqlCacheEpoch");

    expect(mutationInit.method).toBe("POST");
    expect(Number(nextEpoch)).toBeGreaterThan(Number(firstEpoch));
  });

  it("merges a stored cache epoch before bumping", async () => {
    const store = new Map([["prompt-proxy:gql-cache-epoch", "41"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value)
      }
    });
    setGraphQLCacheScope("session:org:workspace");

    bumpGraphQLCacheEpoch();
    await gqlFetch(QueryDocument, { id: "one" });

    const epoch = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost").searchParams.get("gqlCacheEpoch");
    expect(epoch).toBe("42");
  });

  it("restores scoped GETs when route auth uses cached viewer data", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["me"], cachedViewer());
    vi.stubGlobal("EventSource", FakeEventSource);

    await requireAuth({ context: { queryClient } });
    await gqlFetch(QueryDocument, { id: "one" });

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url), "http://localhost");

    expect(init.method).toBe("GET");
    expect(parsed.origin).toBe("http://localhost");
    expect(parsed.pathname).toBe("/admin/graphql");
    expect(parsed.searchParams.get("gqlCacheScope")).toBeTruthy();
  });
});

function cachedViewer(): AuthMe {
  return {
    organizationId: "org_1",
    workspaceId: "workspace_1",
    user: {
      sessionId: "session_1",
      organizationId: "org_1",
      workspaceId: "workspace_1",
      userId: "user_1",
      email: "local@example.com",
      name: "Local User",
      role: "owner"
    },
    organizations: [{ id: "org_1", slug: "local", name: "Local", role: "owner" }],
    workspaces: [{ id: "workspace_1", slug: "default", name: "Default" }]
  };
}
