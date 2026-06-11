import type { z } from "zod";

export type CapabilitySideEffect = "none" | "write";

export type CapabilityContext = {
  organizationId: string;
  workspaceId: string;
  userId: string;
  conversationId: string;
  runId: string;
};

export type CapabilityOutput = Record<string, unknown>;

export type CapabilityDecision =
  | { decision: "executed"; output: CapabilityOutput }
  | { decision: "proposed"; proposalId: string; preview: CapabilityOutput }
  | { decision: "denied"; reason: string };

export type ProposalPreparation = {
  preview: CapabilityOutput;
  baseState?: CapabilityOutput;
  dedupeKey?: string;
};

export type CapabilityDefinition<Input = unknown> = {
  key: string;
  description: string;
  input: z.ZodType<Input>;
} & (
  | {
      sideEffect: "none";
      handler: (context: CapabilityContext, input: Input) => Promise<CapabilityOutput>;
      prepareProposal?: undefined;
    }
  | {
      sideEffect: "write";
      prepareProposal: (context: CapabilityContext, input: Input) => Promise<ProposalPreparation>;
      handler?: undefined;
    }
);

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityDefinition>();

  register<Input>(definition: CapabilityDefinition<Input>) {
    if (this.capabilities.has(definition.key)) {
      throw new Error(`Capability ${definition.key} is already registered.`);
    }
    this.capabilities.set(definition.key, definition as CapabilityDefinition);
    return this;
  }

  get(key: string) {
    return this.capabilities.get(key);
  }

  list() {
    return [...this.capabilities.values()].sort((left, right) => left.key.localeCompare(right.key));
  }
}
