import { describe, expect, it } from "vitest";

import {
  conversationSpan,
  conversationTurns,
  sessionRoute,
  sessionUserName,
  transcriptText,
  type SessionArtifact,
  type SessionDetail,
  type SessionRequest,
  type SessionSummary
} from "./sessionsPageData";

function request(requestId: string, createdAt: string, latencyMs: number | null = 0): SessionRequest {
  return {
    requestId,
    createdAt,
    selectedModel: "gpt-5",
    finalRoute: "balanced",
    terminalStatus: "completed",
    latencyMs,
    selectedCost: 0,
    usage: { totalTokens: 0 }
  };
}

function artifact(overrides: Partial<SessionArtifact> & Pick<SessionArtifact, "artifactId" | "requestId" | "kind" | "contentHash" | "createdAt">): SessionArtifact {
  return {
    sourceIndex: null,
    rawText: null,
    redactedText: null,
    preview: null,
    ...overrides
  };
}

function detail(requests: SessionRequest[], promptArtifacts: SessionArtifact[], user: unknown = null): SessionDetail {
  return {
    session: {
      sessionId: "s1",
      externalSessionId: null,
      userId: "u1",
      surface: "claude-code",
      sessionIdentity: null,
      requestCount: requests.length,
      startedAt: "2026-06-10T10:00:00Z",
      recentActivity: null,
      modelMix: {},
      routeMix: {},
      usage: { totalTokens: 0 },
      cost: { selected: 0 }
    },
    user,
    requests,
    promptArtifacts
  };
}

describe("conversationTurns", () => {
  it("orders turns chronologically and groups artifacts by request", () => {
    const turns = conversationTurns(detail(
      [request("r2", "2026-06-10T10:05:00Z"), request("r1", "2026-06-10T10:00:00Z")],
      [
        artifact({ artifactId: "a1", requestId: "r1", kind: "user_message", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z", rawText: "hi" }),
        artifact({ artifactId: "a2", requestId: "r2", kind: "user_message", contentHash: "h2", createdAt: "2026-06-10T10:05:00Z", rawText: "again" })
      ]
    ));
    expect(turns.map((turn) => turn.request.requestId)).toEqual(["r1", "r2"]);
    expect(turns[0].artifacts.map((a) => a.artifactId)).toEqual(["a1"]);
  });

  it("drops duplicate (kind, contentHash) artifacts that race capture dedup", () => {
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z")],
      [
        artifact({ artifactId: "a1", requestId: "r1", kind: "user_message", contentHash: "dup", createdAt: "2026-06-10T10:00:00Z" }),
        artifact({ artifactId: "a2", requestId: "r1", kind: "user_message", contentHash: "dup", createdAt: "2026-06-10T10:00:01Z" })
      ]
    ));
    expect(turns[0].artifacts).toHaveLength(1);
    expect(turns[0].artifacts[0].artifactId).toBe("a1");
  });

  it("ignores artifacts whose kind is not a known conversation role", () => {
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z")],
      [artifact({ artifactId: "a1", requestId: "r1", kind: "mystery_kind", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z" })]
    ));
    expect(turns[0].artifacts).toHaveLength(0);
  });

  it("measures the gap as idle time before a turn, excluding the prior turn's latency", () => {
    const turns = conversationTurns(detail(
      [
        request("r1", "2026-06-10T10:00:00Z", 2000),
        request("r2", "2026-06-10T10:00:10Z")
      ],
      []
    ));
    expect(turns[0].gapMs).toBeNull();
    // 10s wall gap minus 2s of r1 latency = 8s idle.
    expect(turns[1].gapMs).toBe(8000);
  });
});

describe("conversationSpan", () => {
  it("is null for a single turn", () => {
    const turns = conversationTurns(detail([request("r1", "2026-06-10T10:00:00Z")], []));
    expect(conversationSpan(turns)).toBeNull();
  });

  it("spans first to last request", () => {
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z"), request("r2", "2026-06-10T10:01:00Z")],
      []
    ));
    expect(conversationSpan(turns)).toBe(60000);
  });
});

describe("transcriptText", () => {
  it("renders captured text with role labels and flags uncaptured turns", () => {
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z"), request("r2", "2026-06-10T10:05:00Z")],
      [artifact({ artifactId: "a1", requestId: "r1", kind: "user_message", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z", rawText: "hello" })]
    ));
    const transcript = transcriptText(turns);
    expect(transcript).toContain("User: hello");
    expect(transcript).toContain("content not captured");
  });
});

describe("sessionRoute", () => {
  it("prefers the explicit current route", () => {
    const session = { currentRoute: "deep", routeMix: { fast: 5 } } as unknown as SessionSummary;
    expect(sessionRoute(session)).toBe("deep");
  });

  it("falls back to the dominant route in the mix", () => {
    const session = { currentRoute: null, routeMix: { fast: 1, balanced: 9 } } as unknown as SessionSummary;
    expect(sessionRoute(session)).toBe("balanced");
  });
});

describe("sessionUserName", () => {
  it("prefers the resolved user name, then email, then id", () => {
    expect(sessionUserName(detail([], [], { name: "Ada", email: "ada@x.com" }))).toBe("Ada");
    expect(sessionUserName(detail([], [], { email: "ada@x.com" }))).toBe("ada@x.com");
    expect(sessionUserName(detail([], [], null))).toBe("u1");
  });
});
