import { afterEach, describe, expect, it } from "vitest";

import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

const viewerQuery = `query Viewer {
  viewer {
    organizationId
    workspaceId
    user { sessionId }
  }
}`;

let activeFixture: PromptTestFixture | undefined;

describe("admin GraphQL response cache", () => {
  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("emits private ETags for scoped authenticated GET queries and honors revalidation", async () => {
    const fixture = await setup("org_graphql_response_cache");
    const url = graphQLUrl(fixture.proxyUrl, "scope-a", "0");

    const first = await fetch(url, { headers: fixture.adminHeaders });
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toContain("private");
    expect((await first.json()).data.viewer.organizationId).toBe("org_graphql_response_cache");

    const revalidated = await fetch(url, {
      headers: { ...fixture.adminHeaders, "if-none-match": etag ?? "" }
    });

    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");

    const epochBusted = await fetch(graphQLUrl(fixture.proxyUrl, "scope-a", "1"), {
      headers: fixture.adminHeaders
    });

    expect(epochBusted.status).toBe(200);
    expect(epochBusted.headers.get("etag")).toBeTruthy();
    expect(epochBusted.headers.get("etag")).not.toBe(etag);
  });

  it("does not cache unmarked GET queries", async () => {
    const fixture = await setup("org_graphql_response_cache_unmarked");
    const params = new URLSearchParams({ query: viewerQuery });
    const response = await fetch(`${fixture.proxyUrl}/admin/graphql?${params}`, {
      headers: fixture.adminHeaders
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeNull();
  });
});

async function setup(organizationId: string) {
  activeFixture = await captureFixture(organizationId);
  return activeFixture;
}

function graphQLUrl(proxyUrl: string, scope: string, epoch: string) {
  const params = new URLSearchParams({
    query: viewerQuery,
    gqlCacheScope: scope,
    gqlCacheEpoch: epoch
  });
  return `${proxyUrl}/admin/graphql?${params}`;
}
