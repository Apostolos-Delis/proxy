import { once } from "node:events";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AdminAuthService } from "./adminAuth.js";
import type { ConsoleAgentEventBus } from "./console-agent/eventBus.js";
import { streamRunEvents } from "./console-agent/runEventStream.js";
import type { ConsoleAgentRuntime } from "./console-agent/runtime.js";
import {
  consoleAgentConversationSummary,
  consoleAgentMessageSummary,
  consoleAgentProposalSummary
} from "./persistence/adminSerializers.js";
import type { ProposalResolution } from "./persistence/consoleAgentProposals.js";
import { ConsoleAgentStoreError } from "./persistence/consoleAgentStore.js";
import type { createDatabasePersistence } from "./persistence/index.js";
import { isRecord, notFoundError } from "./util.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
// The console agent reads prompts and proposes config writes, so the whole
// surface is gated to operator roles. This is the single role guard.
const CONSOLE_AGENT_OPERATOR_ROLES = new Set<string>(["owner", "admin"]);
const MAX_TITLE_LENGTH = 500;
const MAX_PAGE_SCOPE_BYTES = 8_192;

type ConsoleAgentRouteDeps = {
  adminAuth: AdminAuthService;
  persistence?: ReturnType<typeof createDatabasePersistence>;
  runtime?: ConsoleAgentRuntime;
  bus: ConsoleAgentEventBus;
};

export function registerConsoleAgentRoutes(app: FastifyInstance, deps: ConsoleAgentRouteDeps) {
  const { adminAuth, persistence, runtime, bus } = deps;

  app.post("/admin/console-agent/conversations", async (request, reply) => {
    const identity = await resolveConsoleAgentOperator(adminAuth, request);
    if (!persistence) throw notFoundError("console_agent_not_available");
    const body = bodyRecord(request.body);
    const title = stringField(body.title);
    if (title && title.length > MAX_TITLE_LENGTH) {
      reply.code(400).send({ error: "title_too_long" });
      return;
    }
    const conversation = await persistence.consoleAgent.createConversation({
      organizationId: identity.organizationId,
      createdByUserId: identity.userId,
      title
    });
    reply.code(201);
    return { conversation: consoleAgentConversationSummary(conversation) };
  });

  app.get("/admin/console-agent/conversations", async (request) => {
    const identity = await resolveConsoleAgentOperator(adminAuth, request);
    if (!persistence) return { data: [] };
    const conversations = await persistence.consoleAgent.listConversations(
      identity.organizationId,
      identity.userId
    );
    return { data: conversations.map(consoleAgentConversationSummary) };
  });

  app.get("/admin/console-agent/conversations/:conversationId", async (request, reply) => {
    const identity = await resolveConsoleAgentOperator(adminAuth, request);
    const conversation = await ownedConversation(deps, identity, request, reply);
    if (!conversation || !persistence) return;
    const messages = await persistence.consoleAgent.listMessages(
      identity.organizationId,
      conversation.id
    );
    const lastRun = await persistence.consoleAgent.getLatestRun(
      identity.organizationId,
      conversation.id
    );
    const proposals = await persistence.consoleAgentProposals.listByConversation(
      identity.organizationId,
      conversation.id
    );
    return {
      conversation: consoleAgentConversationSummary(conversation),
      messages: messages.map(consoleAgentMessageSummary),
      lastRun: lastRun
        ? { id: lastRun.id, status: lastRun.status, error: lastRun.error ?? null }
        : null,
      proposals: proposals.map(consoleAgentProposalSummary)
    };
  });

  app.post("/admin/console-agent/conversations/:conversationId/messages", async (request, reply) => {
    const identity = await resolveConsoleAgentOperator(adminAuth, request);
    const conversation = await ownedConversation(deps, identity, request, reply);
    if (!conversation) return;
    if (!runtime) {
      reply.code(503).send({ error: "console_agent_not_configured" });
      return;
    }
    const body = bodyRecord(request.body);
    const text = stringField(body.text)?.trim();
    if (!text) {
      reply.code(400).send({ error: "text_required" });
      return;
    }
    const pageScope = recordField(body.pageScope);
    if (pageScope && JSON.stringify(pageScope).length > MAX_PAGE_SCOPE_BYTES) {
      reply.code(400).send({ error: "page_scope_too_large" });
      return;
    }

    try {
      const started = await runtime.startTurn({
        organizationId: identity.organizationId,
        userId: identity.userId,
        conversationId: conversation.id,
        text,
        pageScope,
        onEvent: (event) => bus.publish(event)
      });
      started.completion.catch((error) => {
        app.log.error({ err: error, runId: started.runId }, "console agent run failed");
      });
      reply.code(202);
      return { runId: started.runId, conversationId: conversation.id };
    } catch (error) {
      if (error instanceof ConsoleAgentStoreError && error.code === "run_already_active") {
        reply.code(409).send({ error: "run_already_active" });
        return;
      }
      throw error;
    }
  });

  app.get("/admin/console-agent/runs/:runId/events", async (request, reply) => {
    const identity = await resolveConsoleAgentOperator(adminAuth, request);
    const run = await ownedRun(deps, identity, request, reply);
    if (!run || !persistence) return;

    reply.hijack();
    // Carry over hook-set headers (CORS) that bypassing reply.send would drop.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
    }, HEARTBEAT_INTERVAL_MS);

    const sink = {
      write: async (event: { seq?: number; type: string; payload: Record<string, unknown> }) => {
        if (reply.raw.writableEnded) throw new Error("stream closed");
        const id = event.seq === undefined ? "" : `id: ${event.seq}\n`;
        const flushed = reply.raw.write(
          `${id}event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`
        );
        if (!flushed) await once(reply.raw, "drain");
      },
      close: () => {
        clearInterval(heartbeat);
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    };

    try {
      const stream = await streamRunEvents(
        { store: persistence.consoleAgent, bus },
        {
          organizationId: identity.organizationId,
          runId: run.id,
          lastEventId: lastEventIdFrom(request)
        },
        sink
      );
      request.raw.on("close", () => {
        stream.stop();
        clearInterval(heartbeat);
      });
    } catch (error) {
      request.log.error({ err: error, runId: run.id }, "console agent event stream failed");
      sink.close();
    }
  });

  app.post("/admin/console-agent/runs/:runId/cancel", async (request, reply) => {
    const identity = await resolveConsoleAgentOperator(adminAuth, request);
    const run = await ownedRun(deps, identity, request, reply);
    if (!run) return;
    const cancelled = runtime?.cancel(run.id) ?? false;
    return { cancelled };
  });

  app.post("/admin/console-agent/proposals/:proposalId/approve", async (request, reply) => {
    const identity = await resolveConsoleAgentOperator(adminAuth, request);
    if (!persistence) throw notFoundError("proposal_not_found");
    const proposalId = (request.params as { proposalId?: string }).proposalId ?? "";
    try {
      const resolution = await persistence.consoleAgentProposals.approve({
        organizationId: identity.organizationId,
        proposalId,
        approvedByUserId: identity.userId
      });
      sendProposalResolution(reply, resolution);
    } catch (error) {
      request.log.error({ err: error, proposalId }, "proposal execution failed");
      reply.code(500).send({ error: "proposal_execution_failed" });
    }
  });

  app.post("/admin/console-agent/proposals/:proposalId/reject", async (request, reply) => {
    const identity = await resolveConsoleAgentOperator(adminAuth, request);
    if (!persistence) throw notFoundError("proposal_not_found");
    const proposalId = (request.params as { proposalId?: string }).proposalId ?? "";
    const resolution = await persistence.consoleAgentProposals.reject({
      organizationId: identity.organizationId,
      proposalId,
      rejectedByUserId: identity.userId
    });
    sendProposalResolution(reply, resolution);
  });
}

function sendProposalResolution(reply: FastifyReply, resolution: ProposalResolution) {
  switch (resolution.outcome) {
    case "not_found":
      reply.code(404).send({ error: "proposal_not_found" });
      return;
    case "approved":
      reply.send({
        outcome: "approved",
        proposal: consoleAgentProposalSummary(resolution.proposal),
        output: resolution.output
      });
      return;
    case "rejected":
      reply.send({ outcome: "rejected", proposal: consoleAgentProposalSummary(resolution.proposal) });
      return;
    case "unsupported":
      reply.code(501).send({
        outcome: "unsupported",
        error: "proposal_capability_not_supported",
        proposal: consoleAgentProposalSummary(resolution.proposal)
      });
      return;
    case "stale":
    case "already_resolved":
      reply.code(409).send({
        outcome: resolution.outcome,
        error: `proposal_${resolution.outcome}`,
        proposal: consoleAgentProposalSummary(resolution.proposal)
      });
      return;
    case "expired":
      reply.code(410).send({
        outcome: "expired",
        error: "proposal_expired",
        proposal: consoleAgentProposalSummary(resolution.proposal)
      });
      return;
    default:
      assertNever(resolution);
  }
}

async function resolveConsoleAgentOperator(adminAuth: AdminAuthService, request: FastifyRequest) {
  const identity = await adminAuth.resolve(request.headers);
  if (!CONSOLE_AGENT_OPERATOR_ROLES.has(identity.role)) {
    const error = new Error("console_agent_forbidden") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
  return identity;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled proposal resolution: ${JSON.stringify(value)}`);
}

type AdminIdentity = { organizationId: string; userId: string };

async function ownedConversation(
  deps: ConsoleAgentRouteDeps,
  identity: AdminIdentity,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const params = request.params as { conversationId?: string };
  const conversationId = params.conversationId;
  if (!conversationId || !deps.persistence) {
    reply.code(404).send({ error: "conversation_not_found" });
    return null;
  }
  const conversation = await deps.persistence.consoleAgent.getConversation(
    identity.organizationId,
    conversationId
  );
  if (!conversation || conversation.createdByUserId !== identity.userId) {
    reply.code(404).send({ error: "conversation_not_found" });
    return null;
  }
  return conversation;
}

async function ownedRun(
  deps: ConsoleAgentRouteDeps,
  identity: AdminIdentity,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const params = request.params as { runId?: string };
  const runId = params.runId;
  if (!runId || !deps.persistence) {
    reply.code(404).send({ error: "run_not_found" });
    return null;
  }
  const run = await deps.persistence.consoleAgent.getRun(identity.organizationId, runId);
  if (!run) {
    reply.code(404).send({ error: "run_not_found" });
    return null;
  }
  const conversation = await deps.persistence.consoleAgent.getConversation(
    identity.organizationId,
    run.conversationId
  );
  if (!conversation || conversation.createdByUserId !== identity.userId) {
    reply.code(404).send({ error: "run_not_found" });
    return null;
  }
  return run;
}

function lastEventIdFrom(request: FastifyRequest) {
  const header = request.headers["last-event-id"];
  const query = (request.query as Record<string, unknown> | undefined)?.lastEventId;
  let raw: string | undefined;
  if (typeof header === "string") raw = header;
  else if (typeof query === "string") raw = query;
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

function stringField(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordField(value: unknown) {
  return isRecord(value) ? value : undefined;
}
