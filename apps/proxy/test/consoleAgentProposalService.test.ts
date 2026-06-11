import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { consoleAgentConversations, consoleAgentProposals, consoleAgentRuns, createTransactionalDatabase, defaultWorkspaceId, events, organizations, users } from "@prompt-proxy/db";

import {
  ConsoleAgentProposalService,
  type ProposalExecutor
} from "../src/persistence/consoleAgentProposals.js";
import { migratedPgliteDb } from "./consoleAgentTestKit.js";

const ORG = "org_proposals";
const PROPOSER = "user_proposer";
const APPROVER = "user_approver";

describe("console agent proposal service", () => {
  let fixture: Awaited<ReturnType<typeof migratedPgliteDb>>;
  let service: ConsoleAgentProposalService;
  let executions = 0;
  let staleFlag = false;
  let failExecution = false;

  const executor: ProposalExecutor = {
    execute: async () => {
      if (failExecution) throw new Error("execution exploded");
      executions += 1;
      return { applied: true };
    },
    isStale: async () => staleFlag
  };

  beforeAll(async () => {
    fixture = await migratedPgliteDb();
    await fixture.db.insert(organizations).values({ id: ORG, slug: "org-proposals", name: ORG });
    await fixture.db.insert(users).values([{ id: PROPOSER }, { id: APPROVER }]);
    await fixture.db.insert(consoleAgentConversations).values({
      id: "conv_p",
      organizationId: ORG,
      createdByUserId: PROPOSER
    });
    await fixture.db.insert(consoleAgentRuns).values({
      id: "run_p",
      organizationId: ORG,
      conversationId: "conv_p",
      status: "awaiting_approval"
    });
    service = new ConsoleAgentProposalService(
      createTransactionalDatabase(fixture.db),
      fixture.db
    ).registerExecutor("widgets.create.v1", executor);
  });

  afterAll(async () => {
    await fixture.client.close();
  });

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      organizationId: ORG,
      workspaceId: defaultWorkspaceId(ORG),
      conversationId: "conv_p",
      runId: "run_p",
      capabilityKey: "widgets.create.v1",
      proposedByUserId: PROPOSER,
      input: { name: "w" },
      preview: { diff: "+widget w" },
      ...overrides
    };
  }

  it("creates proposals with audit and dedupes pending retries", async () => {
    const created = await service.create(baseInput({ dedupeKey: "dk_create" }));
    expect(created.status).toBe("pending");
    expect(created.proposedByUserId).toBe(PROPOSER);

    const retried = await service.create(baseInput({ dedupeKey: "dk_create" }));
    expect(retried.id).toBe(created.id);

    const audits = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "console_agent.proposal.created"));
    expect(audits).toHaveLength(1);
  });

  it("approves exactly once under concurrent approvals", async () => {
    const proposal = await service.create(baseInput());
    const [first, second] = await Promise.all([
      service.approve({ organizationId: ORG, proposalId: proposal.id, approvedByUserId: APPROVER }),
      service.approve({ organizationId: ORG, proposalId: proposal.id, approvedByUserId: PROPOSER })
    ]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already_resolved", "approved"]);
    expect(executions).toBe(1);

    const approved = first.outcome === "approved" ? first : second;
    if (approved.outcome !== "approved") throw new Error("expected approved");
    expect(approved.output).toEqual({ applied: true });
    expect(approved.proposal.resolvedByUserId).toBeTruthy();

    const audits = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "console_agent.proposal.approved"));
    expect(audits).toHaveLength(1);
  });

  it("marks proposals stale instead of executing when the base state changed", async () => {
    staleFlag = true;
    const proposal = await service.create(baseInput());
    const resolution = await service.approve({
      organizationId: ORG,
      proposalId: proposal.id,
      approvedByUserId: APPROVER
    });
    staleFlag = false;

    expect(resolution.outcome).toBe("stale");
    const [row] = await fixture.db
      .select()
      .from(consoleAgentProposals)
      .where(eq(consoleAgentProposals.id, proposal.id));
    expect(row?.status).toBe("stale");
    expect(executions).toBe(1);
    const audits = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "console_agent.proposal.stale"));
    expect(audits).toHaveLength(1);
  });

  it("refuses expired proposals", async () => {
    const proposal = await service.create(baseInput({ ttlSeconds: -10 }));
    const resolution = await service.approve({
      organizationId: ORG,
      proposalId: proposal.id,
      approvedByUserId: APPROVER
    });
    expect(resolution.outcome).toBe("expired");
    expect(executions).toBe(1);
    const audits = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "console_agent.proposal.expired"));
    expect(audits).toHaveLength(1);
  });

  it("rejects pending proposals and blocks later approval", async () => {
    const proposal = await service.create(baseInput());
    const rejection = await service.reject({
      organizationId: ORG,
      proposalId: proposal.id,
      rejectedByUserId: APPROVER
    });
    expect(rejection.outcome).toBe("rejected");
    const audits = await fixture.db
      .select()
      .from(events)
      .where(eq(events.eventType, "console_agent.proposal.rejected"));
    expect(audits).toHaveLength(1);

    const after = await service.approve({
      organizationId: ORG,
      proposalId: proposal.id,
      approvedByUserId: APPROVER
    });
    expect(after.outcome).toBe("already_resolved");
    expect(executions).toBe(1);
  });

  it("rolls back the claim when execution fails so the proposal stays retryable", async () => {
    failExecution = true;
    const proposal = await service.create(baseInput());
    await expect(
      service.approve({ organizationId: ORG, proposalId: proposal.id, approvedByUserId: APPROVER })
    ).rejects.toThrow("execution exploded");
    failExecution = false;

    const [row] = await fixture.db
      .select()
      .from(consoleAgentProposals)
      .where(eq(consoleAgentProposals.id, proposal.id));
    expect(row?.status).toBe("pending");

    const retried = await service.approve({
      organizationId: ORG,
      proposalId: proposal.id,
      approvedByUserId: APPROVER
    });
    expect(retried.outcome).toBe("approved");
  });

  it("returns unsupported for capabilities without executors and keeps the proposal pending", async () => {
    const proposal = await service.create(
      baseInput({ capabilityKey: "widgets.unknown.v1" })
    );
    const resolution = await service.approve({
      organizationId: ORG,
      proposalId: proposal.id,
      approvedByUserId: APPROVER
    });
    expect(resolution.outcome).toBe("unsupported");
    const [row] = await fixture.db
      .select()
      .from(consoleAgentProposals)
      .where(eq(consoleAgentProposals.id, proposal.id));
    expect(row?.status).toBe("pending");
  });

  it("reports not_found for unknown proposals", async () => {
    const resolution = await service.approve({
      organizationId: ORG,
      proposalId: "prop_missing",
      approvedByUserId: APPROVER
    });
    expect(resolution.outcome).toBe("not_found");
  });
});
