import { describe, expect, it } from "vitest";

import {
  artifactHasStoredText,
  artifactNeedsDetailLink,
  artifactText,
  artifactToolNames,
  conversationTurns,
  dominantRequestStatus,
  sessionDurationMs,
  sessionLogicalModel,
  sessionLogicalModels,
  sessionModel,
  sessionUserName,
  sessionWallMs,
  systemSpans,
  transcriptText,
  type SessionArtifact,
  type SessionDetail,
  type SessionRequest,
  type SessionSummary
} from "./sessionsPageData";

type TestSessionArtifact = SessionArtifact & {
  rawText?: string | null;
  redactedText?: string | null;
};

function usage(overrides: Partial<SessionRequest["usage"]> = {}): SessionRequest["usage"] {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...overrides
  };
}

function request(requestId: string, createdAt: string, latencyMs: number | null = 0): SessionRequest {
  return {
    requestId,
    createdAt,
    selectedModel: "gpt-5",
    requestedLogicalModel: "coding-auto",
    resolvedLogicalModelId: "logical-model-coding-auto",
    terminalStatus: "completed",
    latencyMs,
    selectedCost: 0,
    usage: usage()
  };
}

function artifact(overrides: Partial<TestSessionArtifact> & Pick<SessionArtifact, "artifactId" | "requestId" | "kind" | "contentHash" | "createdAt">): SessionArtifact {
  return {
    sourceIndex: null,
    chars: null,
    rawText: null,
    redactedText: null,
    preview: null,
    tokenEstimate: null,
    metadata: null,
    ...overrides
  } as SessionArtifact;
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
      usage: { inputTokens: 0, outputTokens: 0 },
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

  it("accumulates replayed prior messages and tokens across turns", () => {
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z"), request("r2", "2026-06-10T10:05:00Z")],
      [
        artifact({ artifactId: "a1", requestId: "r1", kind: "system", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z", tokenEstimate: 100 }),
        artifact({ artifactId: "a2", requestId: "r1", kind: "user_message", contentHash: "h2", createdAt: "2026-06-10T10:00:00Z", tokenEstimate: 40 }),
        artifact({ artifactId: "a3", requestId: "r2", kind: "user_message", contentHash: "h3", createdAt: "2026-06-10T10:05:00Z", tokenEstimate: 7 })
      ]
    ));
    expect(turns[0].priorMessages).toBe(0);
    expect(turns[0].priorTokens).toBe(0);
    expect(turns[1].priorMessages).toBe(2);
    expect(turns[1].priorTokens).toBe(140);
  });
});

describe("systemSpans", () => {
  it("spans a system prompt from its first request to the end of the session", () => {
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z"), request("r2", "2026-06-10T10:01:00Z"), request("r3", "2026-06-10T10:02:00Z")],
      [artifact({ artifactId: "sys", requestId: "r1", kind: "system", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z" })]
    ));
    expect(systemSpans(turns).get("sys")).toBe(3);
  });

  it("closes a span when a different system prompt of the same kind appears", () => {
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z"), request("r2", "2026-06-10T10:01:00Z"), request("r3", "2026-06-10T10:02:00Z")],
      [
        artifact({ artifactId: "sysA", requestId: "r1", kind: "system", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z" }),
        artifact({ artifactId: "sysB", requestId: "r3", kind: "system", contentHash: "h2", createdAt: "2026-06-10T10:02:00Z" })
      ]
    ));
    const spans = systemSpans(turns);
    expect(spans.get("sysA")).toBe(2);
    expect(spans.get("sysB")).toBe(1);
  });

  it("ignores non-system artifacts", () => {
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z")],
      [artifact({ artifactId: "a1", requestId: "r1", kind: "user_message", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z" })]
    ));
    expect(systemSpans(turns).size).toBe(0);
  });

  it("spans all same-kind artifacts that arrive in the same request together", () => {
    // OpenAI requests can carry an instructions field plus developer messages,
    // all captured as kind "instructions" within one turn.
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z"), request("r2", "2026-06-10T10:01:00Z"), request("r3", "2026-06-10T10:02:00Z")],
      [
        artifact({ artifactId: "insA", requestId: "r1", kind: "instructions", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z" }),
        artifact({ artifactId: "insB", requestId: "r1", kind: "instructions", contentHash: "h2", createdAt: "2026-06-10T10:00:01Z", sourceIndex: 0 }),
        artifact({ artifactId: "insC", requestId: "r3", kind: "instructions", contentHash: "h3", createdAt: "2026-06-10T10:02:00Z" })
      ]
    ));
    const spans = systemSpans(turns);
    expect(spans.get("insA")).toBe(2);
    expect(spans.get("insB")).toBe(2);
    expect(spans.get("insC")).toBe(1);
  });
});

describe("artifactToolNames", () => {
  const base = { artifactId: "a1", requestId: "r1", kind: "tool_use", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z" };

  it("reads a single toolName and deduped toolNames lists", () => {
    expect(artifactToolNames(artifact({ ...base, metadata: { toolName: "read" } }))).toEqual(["read"]);
    expect(artifactToolNames(artifact({ ...base, metadata: { toolNames: ["read", "edit", "read"] } }))).toEqual(["read", "edit"]);
  });

  it("returns nothing for missing or malformed metadata", () => {
    expect(artifactToolNames(artifact(base))).toEqual([]);
    expect(artifactToolNames(artifact({ ...base, metadata: "read" }))).toEqual([]);
    expect(artifactToolNames(artifact({ ...base, metadata: { toolNames: [1, null] } }))).toEqual([]);
  });
});

describe("artifactText", () => {
  const base = { artifactId: "a1", requestId: "r1", kind: "user_message", contentHash: "h1", createdAt: "2026-06-10T10:00:00Z" };

  it("prefers stored full text over preview text", () => {
    const value = artifact({ ...base, rawText: "full text", preview: "preview" });
    expect(artifactText(value)).toBe("full text");
    expect(artifactHasStoredText(value)).toBe(true);
    expect(artifactNeedsDetailLink(value)).toBe(false);
  });

  it("uses preview text and flags truncated preview-only artifacts", () => {
    const value = artifact({ ...base, preview: "short preview...", chars: 500 });
    expect(artifactText(value)).toBe("short preview...");
    expect(artifactHasStoredText(value)).toBe(false);
    expect(artifactNeedsDetailLink(value)).toBe(true);
  });
});

describe("sessionWallMs", () => {
  it("is null without turns", () => {
    expect(sessionWallMs(conversationTurns(detail([], [])))).toBeNull();
  });

  it("covers a single request via its latency", () => {
    const turns = conversationTurns(detail([request("r1", "2026-06-10T10:00:00Z", 2500)], []));
    expect(sessionWallMs(turns)).toBe(2500);
  });

  it("is null for a single still-running request without latency", () => {
    const turns = conversationTurns(detail([request("r1", "2026-06-10T10:00:00Z", null)], []));
    expect(sessionWallMs(turns)).toBeNull();
  });

  it("spans first request to the last response, including final latency", () => {
    const turns = conversationTurns(detail(
      [request("r1", "2026-06-10T10:00:00Z"), request("r2", "2026-06-10T10:01:00Z", 3000)],
      []
    ));
    expect(sessionWallMs(turns)).toBe(63000);
  });
});

describe("sessionDurationMs", () => {
  it("prefers endedAt, falls back to recentActivity, hides empty spans", () => {
    const base = { startedAt: "2026-06-10T10:00:00Z" } as SessionSummary;
    expect(sessionDurationMs({ ...base, endedAt: "2026-06-10T10:01:00Z", recentActivity: null } as SessionSummary)).toBe(60000);
    expect(sessionDurationMs({ ...base, endedAt: null, recentActivity: "2026-06-10T10:00:30Z" } as SessionSummary)).toBe(30000);
    expect(sessionDurationMs({ ...base, endedAt: null, recentActivity: "2026-06-10T10:00:00Z" } as SessionSummary)).toBeNull();
    expect(sessionDurationMs({ ...base, endedAt: null, recentActivity: null } as SessionSummary)).toBeNull();
  });
});

describe("dominantRequestStatus", () => {
  it("returns the most common terminal status", () => {
    const requests = [
      request("r1", "2026-06-10T10:00:00Z"),
      { ...request("r2", "2026-06-10T10:01:00Z"), terminalStatus: "failed" },
      request("r3", "2026-06-10T10:02:00Z")
    ];
    expect(dominantRequestStatus(requests)).toBe("completed");
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

describe("sessionLogicalModel", () => {
  it("returns dominant and searchable model values from session mixes", () => {
    const session = {
      logicalModelMix: { "economy-auto": 1, "coding-auto": 9 },
      modelMix: { "claude-haiku": 1, "claude-fable": 9 }
    } as unknown as SessionSummary;
    expect(sessionLogicalModel(session)).toBe("coding-auto");
    expect(sessionLogicalModels(session)).toEqual(["economy-auto", "coding-auto"]);
    expect(sessionModel(session)).toBe("claude-fable");
  });
});

describe("sessionUserName", () => {
  it("prefers the resolved user name, then email, then id", () => {
    expect(sessionUserName(detail([], [], { name: "Ada", email: "ada@x.com" }))).toBe("Ada");
    expect(sessionUserName(detail([], [], { email: "ada@x.com" }))).toBe("ada@x.com");
    expect(sessionUserName(detail([], [], null))).toBe("u1");
  });
});
