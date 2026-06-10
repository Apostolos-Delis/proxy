import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { z } from "zod";

import type { CapabilityPolicy } from "./policy.js";
import type { CapabilityContext, CapabilityDecision } from "./registry.js";

export function capabilityToolName(capabilityKey: string) {
  return capabilityKey.replaceAll(".", "_");
}

function capabilityToolSchema(input: z.ZodType<unknown>): TSchema {
  const { $schema: _discarded, ...schema } = z.toJSONSchema(input, { io: "input" });
  return schema as TSchema;
}

export function capabilityTools(
  policy: CapabilityPolicy,
  context: CapabilityContext
): AgentTool<TSchema, CapabilityDecision>[] {
  const names = new Set<string>();
  return policy.capabilities().map((capability) => {
    const name = capabilityToolName(capability.key);
    if (names.has(name)) {
      throw new Error(`Capability tool name collision: ${name} (from ${capability.key})`);
    }
    names.add(name);
    return {
      name,
      label: capability.key,
      description: capability.description,
      parameters: capabilityToolSchema(capability.input),
      execute: async (_toolCallId: string, params: unknown) => {
        const decision = await policy.call(context, capability.key, params);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(decision) }],
          details: decision,
          // A proposed write ends the turn: the run parks awaiting approval.
          terminate: decision.decision === "proposed"
        };
      }
    };
  });
}
