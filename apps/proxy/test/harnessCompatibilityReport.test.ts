import { afterEach, describe, expect, it } from "vitest";

import { HARNESS_COMPATIBILITY_PROFILE_IDS, TRANSLATION_COMPATIBILITY_DIALECTS } from "@prompt-proxy/schema";

import { harnessCompatibilityReport } from "../src/harnessCompatibilityReport.js";
import { listHarnessFixtureManifests } from "../src/harnessFixtureCounts.js";
import { adminGql, captureFixture, type PromptTestFixture } from "./promptTestFixture.js";
import { harnessFixtureRoot } from "./harnessFixtures.js";

const matrixQuery = `query {
  harnessCompatibilityMatrix {
    profileId
    displayName
    harness
    surface
    transport
    targetDialect
    effectiveDialect
    translatedFrom
    translatedTo
    status
    support
    nativeSupport
    translatedSupport
    statefulFeatures
    unsupportedStatefulFeatures
    reasonCodes
    testedFixtureCount
    lastSmokeStatus { status checkedAt detail }
  }
}`;

let activeFixture: PromptTestFixture | undefined;

describe("harness compatibility report", () => {
  afterEach(async () => {
    await activeFixture?.close();
    activeFixture = undefined;
  });

  it("builds matrix rows from shared compatibility logic and fixture metadata", () => {
    const fixtures = listHarnessFixtureManifests(harnessFixtureRoot);
    const rows = harnessCompatibilityReport({ fixtures });

    expect(rows).toHaveLength(
      HARNESS_COMPATIBILITY_PROFILE_IDS.length * TRANSLATION_COMPATIBILITY_DIALECTS.length
    );
    expect(rows.find((row) =>
      row.profileId === "codex-responses-http" &&
      row.targetDialect === "openai-responses"
    )).toMatchObject({
      displayName: "Codex Responses HTTP",
      support: "native",
      nativeSupport: true,
      translatedSupport: false,
      testedFixtureCount: 2
    });
    expect(rows.find((row) =>
      row.profileId === "codex-responses-http" &&
      row.targetDialect === "openai-chat"
    )).toMatchObject({
      support: "blocked",
      nativeSupport: false,
      translatedSupport: false,
      unsupportedStatefulFeatures: ["previous_response_id"],
      reasonCodes: ["stateful_translation_unavailable"],
      testedFixtureCount: 0
    });
    expect(rows.find((row) =>
      row.profileId === "openai-chat-sdk" &&
      row.targetDialect === "anthropic-messages"
    )).toMatchObject({
      support: "translated",
      nativeSupport: false,
      translatedSupport: true,
      translatedFrom: "openai-chat",
      translatedTo: "anthropic-messages",
      testedFixtureCount: 1
    });
    expect(rows.find((row) =>
      row.profileId === "codex-responses-websocket" &&
      row.targetDialect === "openai-chat"
    )).toMatchObject({
      support: "blocked",
      reasonCodes: ["websocket_native_only"]
    });
  });

  it("exposes the matrix through the admin GraphQL API", async () => {
    activeFixture = await captureFixture("org_harness_matrix_api");

    const unauthenticated = await adminGql(activeFixture.proxyUrl, {}, matrixQuery);
    const response = await adminGql(activeFixture.proxyUrl, activeFixture.adminHeaders, matrixQuery);
    const rows = response.data?.harnessCompatibilityMatrix ?? [];
    const codexRow = rows.find((row: any) =>
      row.profileId === "codex-responses-http" &&
      row.targetDialect === "openai-responses"
    );

    expect(unauthenticated.status).toBe(401);
    expect(response.errors).toBeUndefined();
    expect(rows).toHaveLength(
      HARNESS_COMPATIBILITY_PROFILE_IDS.length * TRANSLATION_COMPATIBILITY_DIALECTS.length
    );
    expect(codexRow).toEqual(expect.objectContaining({
      displayName: "Codex Responses HTTP",
      status: "native",
      support: "native",
      testedFixtureCount: 2,
      lastSmokeStatus: null
    }));
  });
});
