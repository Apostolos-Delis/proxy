import { and, desc, eq, sql } from "drizzle-orm";

import {
  consoleAgentProposals,
  type PromptProxyDbSession,
  type PromptProxyTransaction,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";

import { createId } from "../util.js";
import { appendConsoleAgentAuditEvent } from "./consoleAgentAudit.js";

const DEFAULT_PROPOSAL_TTL_SECONDS = 60 * 60 * 24;

function isDomainConflict(error: unknown) {
  if (!(error instanceof Error)) return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500;
}

export type ProposalRow = typeof consoleAgentProposals.$inferSelect;

// Executors hold the deferred capability call: they run inside the approval
// transaction under the approving user's identity. isStale re-checks the
// base-state fingerprint captured at preview time.
export type ProposalExecutor = {
  execute(
    tx: PromptProxyTransaction,
    proposal: ProposalRow,
    approver: { organizationId: string; userId: string }
  ): Promise<Record<string, unknown>>;
  isStale?(tx: PromptProxyTransaction, proposal: ProposalRow): Promise<boolean>;
};

export type ProposalResolution =
  | { outcome: "approved"; proposal: ProposalRow; output: Record<string, unknown> }
  | { outcome: "rejected"; proposal: ProposalRow }
  | { outcome: "stale" | "expired" | "already_resolved"; proposal: ProposalRow }
  | { outcome: "not_found" }
  | { outcome: "unsupported"; proposal: ProposalRow };

export class ConsoleAgentProposalService {
  private readonly executors = new Map<string, ProposalExecutor>();

  constructor(
    private readonly transactional: PromptProxyTransactionalDatabase,
    private readonly db: PromptProxyDbSession
  ) {}

  hasExecutor(capabilityKey: string) {
    return this.executors.has(capabilityKey);
  }

  registerExecutor(capabilityKey: string, executor: ProposalExecutor) {
    if (this.executors.has(capabilityKey)) {
      throw new Error(`Proposal executor for ${capabilityKey} is already registered.`);
    }
    this.executors.set(capabilityKey, executor);
    return this;
  }

  async create(input: {
    organizationId: string;
    workspaceId: string;
    conversationId: string;
    runId: string;
    capabilityKey: string;
    proposedByUserId: string;
    input: Record<string, unknown>;
    preview: Record<string, unknown>;
    baseState?: Record<string, unknown>;
    dedupeKey?: string;
    ttlSeconds?: number;
  }): Promise<ProposalRow> {
    return this.transactional.transaction(async (tx) => {
      const expiresAt = new Date(
        Date.now() + (input.ttlSeconds ?? DEFAULT_PROPOSAL_TTL_SECONDS) * 1000
      );
      const values = {
        id: createId("console_agent_proposal"),
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        runId: input.runId,
        capabilityKey: input.capabilityKey,
        input: input.input,
        preview: input.preview,
        baseState: input.baseState,
        dedupeKey: input.dedupeKey,
        proposedByUserId: input.proposedByUserId,
        expiresAt
      };

      const inserted = input.dedupeKey
        ? await tx
            .insert(consoleAgentProposals)
            .values(values)
            .onConflictDoNothing({
              target: [consoleAgentProposals.organizationId, consoleAgentProposals.dedupeKey],
              where: sql`status = 'pending'`
            })
            .returning()
        : await tx.insert(consoleAgentProposals).values(values).returning();

      const [proposal] = inserted;
      if (!proposal) {
        const existing = await this.pendingByDedupeKey(tx, input.organizationId, input.dedupeKey ?? "");
        if (existing) return existing;
        throw new Error("Failed to create proposal.");
      }
      await this.audit(tx, proposal, input.proposedByUserId, "console_agent.proposal.created");
      return proposal;
    });
  }

  async approve(input: {
    organizationId: string;
    proposalId: string;
    approvedByUserId: string;
  }): Promise<ProposalResolution> {
    return this.transactional.transaction(async (tx) => {
      const existing = await this.byId(tx, input.organizationId, input.proposalId);
      if (!existing) return { outcome: "not_found" };
      if (existing.status !== "pending") return { outcome: "already_resolved", proposal: existing };

      const executor = this.executors.get(existing.capabilityKey);
      if (!executor) {
        await this.audit(tx, existing, input.approvedByUserId, "console_agent.proposal.unsupported");
        return { outcome: "unsupported", proposal: existing };
      }

      const now = new Date();
      if (existing.expiresAt <= now) {
        const expired = await this.transition(tx, existing, { status: "expired" });
        await this.audit(tx, expired, input.approvedByUserId, "console_agent.proposal.expired");
        return { outcome: "expired", proposal: expired };
      }

      const [claimed] = await tx
        .update(consoleAgentProposals)
        .set({
          status: "approved",
          resolvedByUserId: input.approvedByUserId,
          resolvedAt: now
        })
        .where(and(
          eq(consoleAgentProposals.organizationId, input.organizationId),
          eq(consoleAgentProposals.id, input.proposalId),
          eq(consoleAgentProposals.status, "pending")
        ))
        .returning();
      if (!claimed) {
        const resolved = await this.byId(tx, input.organizationId, input.proposalId);
        return resolved
          ? { outcome: "already_resolved", proposal: resolved }
          : { outcome: "not_found" };
      }

      if (executor.isStale && (await executor.isStale(tx, claimed))) {
        const stale = await this.transition(tx, claimed, { status: "stale" });
        await this.audit(tx, stale, input.approvedByUserId, "console_agent.proposal.stale");
        return { outcome: "stale", proposal: stale };
      }

      let output: Record<string, unknown>;
      try {
        output = await executor.execute(tx, claimed, {
          organizationId: input.organizationId,
          userId: input.approvedByUserId
        });
      } catch (error) {
        // Domain conflicts (4xx) mean the world moved since the preview:
        // resolve as stale instead of rolling back to retry-forever pending.
        if (isDomainConflict(error)) {
          const stale = await this.transition(tx, claimed, { status: "stale" });
          await this.audit(tx, stale, input.approvedByUserId, "console_agent.proposal.stale");
          return { outcome: "stale", proposal: stale };
        }
        throw error;
      }
      await this.audit(tx, claimed, input.approvedByUserId, "console_agent.proposal.approved");
      return { outcome: "approved", proposal: claimed, output };
    });
  }

  async reject(input: {
    organizationId: string;
    proposalId: string;
    rejectedByUserId: string;
  }): Promise<ProposalResolution> {
    return this.transactional.transaction(async (tx) => {
      const [rejected] = await tx
        .update(consoleAgentProposals)
        .set({
          status: "rejected",
          resolvedByUserId: input.rejectedByUserId,
          resolvedAt: new Date()
        })
        .where(and(
          eq(consoleAgentProposals.organizationId, input.organizationId),
          eq(consoleAgentProposals.id, input.proposalId),
          eq(consoleAgentProposals.status, "pending")
        ))
        .returning();
      if (!rejected) {
        const existing = await this.byId(tx, input.organizationId, input.proposalId);
        return existing
          ? { outcome: "already_resolved", proposal: existing }
          : { outcome: "not_found" };
      }
      await this.audit(tx, rejected, input.rejectedByUserId, "console_agent.proposal.rejected");
      return { outcome: "rejected", proposal: rejected };
    });
  }

  async listByConversation(organizationId: string, conversationId: string) {
    return this.db
      .select()
      .from(consoleAgentProposals)
      .where(and(
        eq(consoleAgentProposals.organizationId, organizationId),
        eq(consoleAgentProposals.conversationId, conversationId)
      ))
      .orderBy(desc(consoleAgentProposals.createdAt));
  }

  private async byId(tx: PromptProxyTransaction, organizationId: string, proposalId: string) {
    const [proposal] = await tx
      .select()
      .from(consoleAgentProposals)
      .where(and(
        eq(consoleAgentProposals.organizationId, organizationId),
        eq(consoleAgentProposals.id, proposalId)
      ))
      .limit(1);
    return proposal ?? null;
  }

  private async pendingByDedupeKey(
    tx: PromptProxyTransaction,
    organizationId: string,
    dedupeKey: string
  ) {
    const [proposal] = await tx
      .select()
      .from(consoleAgentProposals)
      .where(and(
        eq(consoleAgentProposals.organizationId, organizationId),
        eq(consoleAgentProposals.dedupeKey, dedupeKey),
        eq(consoleAgentProposals.status, "pending")
      ))
      .limit(1);
    return proposal ?? null;
  }

  private async transition(
    tx: PromptProxyTransaction,
    proposal: ProposalRow,
    patch: Partial<Pick<ProposalRow, "status" | "resolvedByUserId" | "resolvedAt">>
  ) {
    const [updated] = await tx
      .update(consoleAgentProposals)
      .set(patch)
      .where(and(
        eq(consoleAgentProposals.organizationId, proposal.organizationId),
        eq(consoleAgentProposals.id, proposal.id)
      ))
      .returning();
    if (!updated) {
      throw new Error(`Proposal ${proposal.id} disappeared during a status transition.`);
    }
    return updated;
  }

  private async audit(
    tx: PromptProxyTransaction,
    proposal: ProposalRow,
    actorUserId: string,
    eventType: string
  ) {
    await appendConsoleAgentAuditEvent(tx, {
      organizationId: proposal.organizationId,
      conversationId: proposal.conversationId,
      runId: proposal.runId,
      actorUserId,
      eventType,
      payload: {
        proposalId: proposal.id,
        capabilityKey: proposal.capabilityKey,
        conversationId: proposal.conversationId,
        runId: proposal.runId
      }
    });
  }
}
