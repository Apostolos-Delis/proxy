import type { ConsoleAgentProposalService } from "../persistence/consoleAgentProposals.js";
import type { CapabilityContext, CapabilityDecision, CapabilityRegistry } from "./registry.js";

export type CapabilityAuditor = {
  auditCapabilityExecuted(context: CapabilityContext, capabilityKey: string): Promise<void>;
};

export type ProposalCreator = Pick<ConsoleAgentProposalService, "create">;

export class CapabilityInputError extends Error {
  constructor(capabilityKey: string, issues: string[]) {
    super(`Invalid input for ${capabilityKey}: ${issues.join("; ")}`);
    this.name = "CapabilityInputError";
  }
}

export class CapabilityPolicy {
  private proposed = false;

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly auditor: CapabilityAuditor,
    private readonly proposals?: ProposalCreator
  ) {}

  get proposalCreated() {
    return this.proposed;
  }

  capabilities() {
    return this.registry.list();
  }

  async call(
    context: CapabilityContext,
    capabilityKey: string,
    rawInput: unknown
  ): Promise<CapabilityDecision> {
    const capability = this.registry.get(capabilityKey);
    if (!capability) {
      return { decision: "denied", reason: `Unknown capability: ${capabilityKey}` };
    }

    const parsed = capability.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new CapabilityInputError(
        capabilityKey,
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      );
    }

    if (capability.sideEffect === "write") {
      if (!this.proposals) {
        throw new Error(
          `Capability ${capabilityKey} is write-gated and requires the proposal flow, which is not available yet.`
        );
      }
      const prepared = await capability.prepareProposal(context, parsed.data);
      const proposal = await this.proposals.create({
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        conversationId: context.conversationId,
        runId: context.runId,
        capabilityKey,
        proposedByUserId: context.userId,
        input: parsed.data as Record<string, unknown>,
        preview: prepared.preview,
        baseState: prepared.baseState,
        dedupeKey: prepared.dedupeKey
      });
      this.proposed = true;
      return { decision: "proposed", proposalId: proposal.id, preview: prepared.preview };
    }

    const output = await capability.handler(context, parsed.data);
    await this.auditor.auditCapabilityExecuted(context, capabilityKey);
    return { decision: "executed", output };
  }
}
