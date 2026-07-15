import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  apiKeys,
  defaultWorkspaceId,
  organizations,
  promptArtifacts,
  requests,
  routeDecisions,
  routingConfigs,
  users,
  workspaces
} from "@proxy/db";

import {
  adminGql,
  captureFixture,
  sessionPrompt,
  usageDecision,
  usageRequest,
  type PromptTestFixture
} from "./promptTestFixture.js";

describe("admin global search", () => {
  let activeFixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("searches org-scoped sessions, logs, users, routing configs, and api keys", async () => {
    const fixture = await setup("org_search_admin");
    const createdAt = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(organizations).values({
      id: "org_search_other",
      slug: "org-search-other",
      name: "Other Search Org"
    });
    await fixture.db.insert(workspaces).values({
      id: defaultWorkspaceId("org_search_other"),
      organizationId: "org_search_other",
      slug: "default",
      name: "Default"
    });
    await fixture.db.insert(users).values([
      { id: "user_zebra", name: "Marisol Zebra", email: "marisol@example.com" },
      { id: "user_other", name: "Other Zebra", email: "other-zebra@example.com" }
    ]);
    await fixture.db.insert(agentSessions).values([
      {
        id: "session_zebra",
        organizationId: "org_search_admin",
        workspaceId: defaultWorkspaceId("org_search_admin"),
        userId: "user_zebra",
        surface: "openai-responses",
        externalSessionId: "codex-zebra-001",
        currentRoute: "balanced"
      },
      {
        id: "session_other_zebra",
        organizationId: "org_search_other",
        workspaceId: defaultWorkspaceId("org_search_other"),
        userId: "user_other",
        surface: "openai-responses",
        externalSessionId: "codex-zebra-other"
      }
    ]);
    await fixture.db.insert(requests).values([
      usageRequest("request_zebra", "org_search_admin", "user_zebra", "session_zebra", "openai-responses", createdAt),
      usageRequest("request_other", "org_search_other", "user_other", "session_other_zebra", "openai-responses", createdAt)
    ]);
    await fixture.db.insert(routeDecisions).values([
      usageDecision("decision_zebra", "request_zebra", "org_search_admin", "fast", "openai", "gpt-zebra")
    ]);
    await fixture.db.insert(promptArtifacts).values([
      sessionPrompt("artifact_zebra", "org_search_admin", "request_zebra", "Investigate the zebra checkout regression in staging", createdAt),
      {
        ...sessionPrompt("artifact_zebra_hidden", "org_search_admin", "request_zebra", "zebra assistant reply", createdAt),
        kind: "assistant_response"
      },
      sessionPrompt("artifact_other", "org_search_other", "request_other", "zebra text in another org", createdAt)
    ]);
    await fixture.db.insert(routingConfigs).values([
      {
        id: "config_zebra",
        organizationId: "org_search_admin",
        workspaceId: defaultWorkspaceId("org_search_admin"),
        name: "Zebra Routing",
        slug: "zebra-routing",
        description: "Routes zebra traffic"
      },
      {
        id: "config_other",
        organizationId: "org_search_other",
        workspaceId: defaultWorkspaceId("org_search_other"),
        name: "Zebra Routing Other",
        slug: "zebra-routing-other"
      }
    ]);
    await fixture.db.insert(apiKeys).values([
      {
        id: "key_zebra",
        organizationId: "org_search_admin",
        workspaceId: defaultWorkspaceId("org_search_admin"),
        keyHash: "hash_key_zebra",
        name: "zebra-ci-key",
        routingConfigId: "config_zebra"
      },
      {
        id: "key_other",
        organizationId: "org_search_other",
        workspaceId: defaultWorkspaceId("org_search_other"),
        keyHash: "hash_key_other",
        name: "zebra-other-key"
      }
    ]);

    const search = await fetchSearch(fixture, "zebra");
    const kinds = new Map(search.results.map((hit: any) => [`${hit.kind}:${hit.id}`, hit]));

    expect(search.query).toBe("zebra");
    expect(kinds.get("session:session_zebra")).toEqual(expect.objectContaining({
      title: "codex-zebra-001",
      subtitle: "openai-responses · balanced",
      status: "active"
    }));
    expect(kinds.get("log:artifact_zebra")).toEqual(expect.objectContaining({
      title: "Investigate the zebra checkout regression in staging",
      subtitle: "gpt-zebra · fast",
      snippet: expect.stringContaining("zebra checkout regression")
    }));
    expect(kinds.get("user:user_zebra")).toEqual(expect.objectContaining({
      title: "Marisol Zebra",
      subtitle: "marisol@example.com"
    }));
    expect(kinds.get("routing_config:config_zebra")).toEqual(expect.objectContaining({
      title: "Zebra Routing",
      subtitle: "Routes zebra traffic",
      status: "active"
    }));
    expect(kinds.get("api_key:key_zebra")).toEqual(expect.objectContaining({
      title: "zebra-ci-key",
      subtitle: "Zebra Routing",
      status: "active"
    }));
    expect(kinds.has("log:artifact_zebra_hidden")).toBe(false);
    expect(search.results.every((hit: any) => !hit.id.includes("other"))).toBe(true);
  });

  it("matches identifiers, escapes like wildcards, and rejects short queries", async () => {
    const fixture = await setup("org_search_ids");
    const createdAt = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(users).values({ id: "user_ids" });
    await fixture.db.insert(agentSessions).values({
      id: "session_ids",
      organizationId: "org_search_ids",
      workspaceId: defaultWorkspaceId("org_search_ids"),
      userId: "user_ids",
      surface: "openai-responses"
    });
    await fixture.db.insert(requests).values(
      usageRequest("request_ids_4242", "org_search_ids", "user_ids", "session_ids", "openai-responses", createdAt)
    );
    await fixture.db.insert(promptArtifacts).values(
      sessionPrompt("artifact_ids", "org_search_ids", "request_ids_4242", "Plain prompt text covering 100% of cases", createdAt)
    );

    const byRequestId = await fetchSearch(fixture, "ids_4242");
    expect(byRequestId.results.map((hit: any) => `${hit.kind}:${hit.id}`)).toContain("log:artifact_ids");

    const proseWord = await fetchSearch(fixture, "request");
    expect(proseWord.results.map((hit: any) => `${hit.kind}:${hit.id}`)).not.toContain("log:artifact_ids");

    const wildcard = await fetchSearch(fixture, "100%");
    expect(wildcard.results.map((hit: any) => `${hit.kind}:${hit.id}`)).toEqual(["log:artifact_ids"]);

    const noWildcardMatch = await fetchSearch(fixture, "10%0");
    expect(noWildcardMatch.results).toEqual([]);

    const shortQuery = await fetchSearch(fixture, "a");
    expect(shortQuery.results).toEqual([]);
  });

  it("rejects route decisions from a different workspace before log search", async () => {
    const fixture = await setup("org_search_route_scope");
    const createdAt = new Date("2026-06-08T12:00:00.000Z");

    await fixture.db.insert(workspaces).values({
      id: "ws_search_route_other",
      organizationId: "org_search_route_scope",
      slug: "other",
      name: "Other"
    });
    await fixture.db.insert(users).values({ id: "user_search_route" });
    await fixture.db.insert(agentSessions).values({
      id: "session_search_route",
      organizationId: "org_search_route_scope",
      workspaceId: defaultWorkspaceId("org_search_route_scope"),
      userId: "user_search_route",
      surface: "openai-responses"
    });
    await fixture.db.insert(requests).values(
      usageRequest("request_search_route", "org_search_route_scope", "user_search_route", "session_search_route", "openai-responses", createdAt)
    );
    await fixture.db.insert(promptArtifacts).values(
      sessionPrompt("artifact_search_route", "org_search_route_scope", "request_search_route", "Find the workspace leak", createdAt)
    );
    await expect(fixture.db.insert(routeDecisions).values({
      ...usageDecision("decision_search_route_wrong_workspace", "request_search_route", "org_search_route_scope", "fast", "openai", "gpt-wrong-workspace"),
      workspaceId: "ws_search_route_other"
    })).rejects.toMatchObject({ cause: { constraint: "route_decisions_request_scope_fk" } });

    const search = await fetchSearch(fixture, "workspace leak");
    expect(search.results).toEqual([
      expect.objectContaining({
        kind: "log",
        id: "artifact_search_route",
        subtitle: "router-auto"
      })
    ]);
  });

  async function fetchSearch(fixture: PromptTestFixture, query: string) {
    const result = await adminGql(
      fixture.proxyUrl,
      fixture.adminHeaders,
      `query Search($query: String!) {
        search(query: $query) {
          query
          results { kind id title subtitle status snippet occurredAt }
        }
      }`,
      { query }
    );
    expect(result.status).toBe(200);
    expect(result.errors).toBeUndefined();
    return result.data?.search;
  }

  async function setup(organizationId: string) {
    activeFixture = await captureFixture(organizationId);
    return activeFixture;
  }
});
