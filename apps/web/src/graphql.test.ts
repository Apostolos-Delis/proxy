import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TypedDocumentString } from "./gql/graphql";
import { bumpGraphQLCacheEpoch, gqlFetch, setGraphQLCacheScope } from "./graphql";

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
    const parsed = new URL(String(url));

    expect(init.method).toBe("GET");
    expect(parsed.searchParams.get("variables")).toBe(JSON.stringify({ id: "one" }));
    expect(parsed.searchParams.get("gqlCacheScope")).toBe("session:org:workspace");
    expect(parsed.searchParams.get("gqlCacheEpoch")).toMatch(/^\d+$/);
  });

  it("keeps mutations on POST and advances the cache epoch for later queries", async () => {
    setGraphQLCacheScope("session:org:workspace");

    await gqlFetch(QueryDocument, { id: "one" });
    const firstEpoch = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("gqlCacheEpoch");
    await gqlFetch(MutationDocument, { id: "one" });
    await gqlFetch(QueryDocument, { id: "one" });

    const [, mutationInit] = fetchMock.mock.calls[1];
    const nextEpoch = new URL(String(fetchMock.mock.calls[2][0])).searchParams.get("gqlCacheEpoch");

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

    const epoch = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("gqlCacheEpoch");
    expect(epoch).toBe("42");
  });
});
