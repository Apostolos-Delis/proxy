import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createPgliteDatabase } from "@prompt-proxy/db";

import type { CapabilityDecision } from "../src/console-agent/registry.js";

export async function migratedPgliteDb() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    await client.exec(await readFile(join(migrationsDir, file), "utf8"));
  }
  return { client, db: createPgliteDatabase(client) };
}

export const stubModel: Model<"anthropic-messages"> = {
  id: "stub-model",
  name: "Stub Model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://127.0.0.1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_192
};

export function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "stub-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

export function assistantToolCall(name: string, args: Record<string, unknown>): AssistantMessage {
  return {
    ...assistantText(""),
    content: [{ type: "toolCall", id: `call_${name}`, name, arguments: args }],
    stopReason: "toolUse"
  };
}

export function scriptedStream(script: AssistantMessage[]): StreamFn {
  let call = 0;
  return () => {
    const stream = createAssistantMessageEventStream();
    const message = script[call];
    if (!message) throw new Error(`scripted stream exhausted after ${script.length} calls`);
    call += 1;
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "toolUse") {
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        stream.push({ type: "done", reason: "stop", message });
      }
    });
    return stream;
  };
}

export function gatedStream(script: AssistantMessage[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inner = scriptedStream(script);
  const streamFn: StreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      await gate;
      for await (const event of await inner(model, context, options)) {
        stream.push(event);
      }
    })();
    return stream;
  };
  return { streamFn, release };
}

export function executed(result: CapabilityDecision) {
  if (result.decision !== "executed") {
    throw new Error(`expected executed decision, got ${result.decision}`);
  }
  return result.output;
}
