import WebSocket from "ws";

import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  accessProfileModelGrants,
  accessProfiles,
  logicalModels,
  requests
} from "@proxy/db";

import {
  logicalTarget,
  nextMessage,
  opened
} from "./gatewayRuntimeTestHelpers.js";
import { captureFixture, type PromptTestFixture } from "./promptTestFixture.js";

describe("logical-model WebSocket runtime", () => {
  let fixture: PromptTestFixture | undefined;

  afterEach(async () => {
    await fixture?.close();
  });

  it("enforces parameter caps on WebSocket requests and terminalizes denial state", async () => {
    fixture = await captureFixture("org_gateway_runtime_ws_caps", "hash_only");
    const [profile] = await fixture.db
      .select({ id: accessProfiles.id })
      .from(accessProfiles)
      .where(eq(accessProfiles.slug, "opendoor-engineer"))
      .limit(1);
    const [model] = await fixture.db
      .select({ id: logicalModels.id })
      .from(logicalModels)
      .where(eq(logicalModels.slug, "coding-auto"))
      .limit(1);
    await fixture.db
      .update(accessProfileModelGrants)
      .set({ parameterCaps: { max_output_tokens: 32 } })
      .where(and(
        eq(accessProfileModelGrants.accessProfileId, profile!.id),
        eq(accessProfileModelGrants.logicalModelId, model!.id)
      ));
    const providerCallsBefore = fixture.openai.records.length + fixture.anthropic.records.length;

    const socket = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    await opened(socket);
    const errorMessage = nextMessage(socket, (message) => message.includes("parameter_cap_exceeded"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Exceed the configured cap",
      max_output_tokens: 64
    }));
    const error = JSON.parse(await errorMessage);
    expect(error).toMatchObject({
      type: "error",
      status: 400,
      error: { message: "parameter_cap_exceeded" }
    });
    expect(fixture.openai.records.length + fixture.anthropic.records.length)
      .toBe(providerCallsBefore);
    const [request] = await fixture.db
      .select({ status: requests.status })
      .from(requests)
      .where(eq(requests.requestedLogicalModel, "coding-auto"))
      .limit(1);
    expect(request?.status).toBe("failed");
    socket.close();
  });

  it("rejects overlapping WebSocket requests without corrupting the active request", async () => {
    const classifierOutput: Record<string, unknown> = {
      target_id: "pending",
      reason_codes: ["capability_match"],
      confidence: 0.91
    };
    fixture = await captureFixture("org_gateway_runtime_ws_overlap", "hash_only", false, {
      openAIOptions: {
        classifierOutput,
        classifierResponsesShape: true,
        wsResponseDelayMs: 100
      }
    });
    const target = await logicalTarget(fixture, "coding-auto", "openai");
    classifierOutput.target_id = target.targetId;
    const socket = new WebSocket(
      fixture.proxyUrl.replace("http://", "ws://") + "/v1/responses",
      { headers: { authorization: "Bearer proxy-token" } }
    );
    await opened(socket);

    const created = nextMessage(socket, (message) => message.includes("response.created"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "First request"
    }));
    await created;
    const rejected = nextMessage(socket, (message) => message.includes("websocket_request_already_active"));
    const completed = nextMessage(socket, (message) => message.includes("response.completed"));
    socket.send(JSON.stringify({
      type: "response.create",
      model: "coding-auto",
      input: "Overlapping request"
    }));

    expect(JSON.parse(await rejected)).toMatchObject({
      type: "error",
      status: 409,
      error: { message: "websocket_request_already_active" }
    });
    expect(await completed).toContain("response.completed");
    const providerCalls = fixture.openai.records.filter((record) => (
      record.path === "/responses" && record.body.type === "response.create"
    ));
    expect(providerCalls).toHaveLength(1);
    expect(fixture.openai.records.filter((record) => record.body.model === "route-classifier-cheap"))
      .toHaveLength(1);
    const requestRows = await fixture.db.select({ status: requests.status }).from(requests);
    expect(requestRows).toEqual([{ status: "completed" }]);
    socket.close();
  });
});
