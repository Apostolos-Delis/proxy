import { describe, expect, it } from "vitest";

import type { SearchHit } from "./searchData";
import { buildPaletteGroups, matchSegments } from "./searchData";

const hit = (overrides: Partial<SearchHit>): SearchHit => ({
  kind: "log",
  id: "artifact_1",
  title: "Fix the checkout flow",
  subtitle: "gpt-5 · coding-auto",
  status: null,
  snippet: null,
  occurredAt: "2026-06-08T12:00:00.000Z",
  ...overrides
});

describe("buildPaletteGroups", () => {
  it("shows recents and all pages for an empty query", () => {
    const groups = buildPaletteGroups({
      query: "",
      hits: [],
      recents: [{ kind: "session", id: "session_1", title: "codex-1", subtitle: "openai-responses" }]
    });
    expect(groups.map((group) => group.label)).toEqual(["Recent", "Pages"]);
    expect(groups[1].actions.map((action) => action.title)).toContain("API keys");
  });

  it("filters pages by title and keywords and groups hits by kind", () => {
    const groups = buildPaletteGroups({
      query: "token",
      hits: [
        hit({ kind: "session", id: "session_1", title: "codex-token-1" }),
        hit({ kind: "log", id: "artifact_1", snippet: "...rotate the token before..." }),
        hit({ kind: "api_key", id: "key_1", title: "token-ci" })
      ],
      recents: []
    });
    expect(groups.map((group) => group.label)).toEqual(["Pages", "Logs", "Sessions", "API keys"]);
    const pageTitles = groups[0].actions.map((action) => action.title);
    expect(pageTitles).toContain("Usage");
    expect(pageTitles).toContain("API keys");
    expect(groups[1].actions[0].title).toBe("...rotate the token before...");
  });

  it("hides quiet statuses and keeps noteworthy ones", () => {
    const groups = buildPaletteGroups({
      query: "deploy",
      hits: [
        hit({ id: "artifact_ok", title: "deploy ok", status: "completed" }),
        hit({ id: "artifact_bad", title: "deploy bad", status: "failed" })
      ],
      recents: []
    });
    const logs = groups.find((group) => group.label === "Logs");
    expect(logs?.actions.map((action) => action.status)).toEqual([null, "failed"]);
  });

  it("drops empty groups", () => {
    const groups = buildPaletteGroups({ query: "zzzz-nothing", hits: [], recents: [] });
    expect(groups).toEqual([]);
  });

  it("filters admin pages, hits, and recents for non-admin users", () => {
    const groups = buildPaletteGroups({
      query: "",
      hits: [hit({ kind: "api_key", id: "key_1", title: "prod key" })],
      recents: [
        { kind: "page", id: "/users", title: "Users", subtitle: "Team & access" },
        { kind: "page", id: "/usage", title: "Usage", subtitle: "Token metering" },
        { kind: "log", id: "artifact_1", title: "Prompt", subtitle: null }
      ],
      isAdmin: false
    });

    expect(groups.map((group) => group.label)).toEqual(["Recent", "Pages"]);
    expect(groups[0].actions.map((action) => action.id)).toEqual(["/usage"]);
    expect(groups[1].actions.map((action) => action.id)).toEqual(["/", "/usage", "/cost", "/caching"]);
  });

  it("keeps admin-only palette entries for admins", () => {
    const groups = buildPaletteGroups({
      query: "token",
      hits: [hit({ kind: "api_key", id: "key_1", title: "token-ci" })],
      recents: [],
      isAdmin: true
    });

    expect(groups.map((group) => group.label)).toContain("API keys");
  });
});

describe("matchSegments", () => {
  it("splits text around case-insensitive matches", () => {
    expect(matchSegments("Retry the RETRY loop", "retry")).toEqual([
      { text: "Retry", match: true },
      { text: " the ", match: false },
      { text: "RETRY", match: true },
      { text: " loop", match: false }
    ]);
  });

  it("returns the whole text when the query is blank", () => {
    expect(matchSegments("plain text", "  ")).toEqual([{ text: "plain text", match: false }]);
  });
});
