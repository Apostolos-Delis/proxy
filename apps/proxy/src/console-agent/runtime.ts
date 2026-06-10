import { Agent, type AgentMessage, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { AppConfig } from "../config.js";
import type { ConsoleAgentRunFinalStatus, ConsoleAgentStore } from "../persistence/consoleAgentStore.js";
import { defaultWorkspaceId } from "@prompt-proxy/db";
import { isRecord } from "../util.js";
import type { ProposalCreator } from "./policy.js";
import { joinedAssistantText, mapPiEvent, terminalEventFor } from "./eventMapper.js";
import type { ConsoleAgentEvent } from "./eventMapper.js";
import { redactRunEventPayload } from "./redaction.js";
import { askUserQuestionTool, type AskedQuestion } from "./questions.js";
import { CapabilityPolicy } from "./policy.js";
import type { CapabilityContext, CapabilityRegistry } from "./registry.js";
import { buildConsoleAgentSystemPrompt } from "./systemPrompt.js";
import { capabilityToolName, capabilityTools } from "./tools.js";

export type ConsoleAgentEmittedEvent = ConsoleAgentEvent & { runId: string; seq?: number };

export type ConsoleAgentStreamFn = StreamFn;

export type ConsoleAgentRunLimits = {
  maxTurns: number;
  maxToolCallsPerTurn: number;
  timeoutMs: number;
};

const DEFAULT_RUN_LIMITS: ConsoleAgentRunLimits = {
  maxTurns: 16,
  maxToolCallsPerTurn: 8,
  timeoutMs: 120_000
};

export type ConsoleAgentRuntimeDeps = {
  store: ConsoleAgentStore;
  registry: CapabilityRegistry;
  model: Model<"anthropic-messages">;
  thinkingLevel: ThinkingLevel;
  proposals?: ProposalCreator;
  apiKey?: string;
  streamFn?: StreamFn;
  limits?: ConsoleAgentRunLimits;
};

export class ConsoleAgentRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleAgentRuntimeError";
  }
}

export function consoleAgentModel(config: AppConfig): Model<"anthropic-messages"> {
  // Limits assume the alias resolves to a hard-tier Anthropic model; pi uses
  // maxTokens as the request output cap.
  return {
    id: config.consoleAgentModel,
    name: "Prompt Proxy Console Agent",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: config.consoleAgentBaseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000
  };
}

export function createConsoleAgentRuntime(input: {
  config: AppConfig;
  store: ConsoleAgentStore;
  registry: CapabilityRegistry;
  proposals?: ProposalCreator;
  streamFn?: StreamFn;
}) {
  if (!input.streamFn && !input.config.consoleAgentApiKey) return undefined;
  return new ConsoleAgentRuntime({
    store: input.store,
    registry: input.registry,
    model: consoleAgentModel(input.config),
    thinkingLevel: input.config.consoleAgentThinkingLevel,
    proposals: input.proposals,
    apiKey: input.config.consoleAgentApiKey,
    streamFn: input.streamFn,
    limits: {
      maxTurns: input.config.consoleAgentMaxTurns,
      maxToolCallsPerTurn: input.config.consoleAgentMaxToolCallsPerTurn,
      timeoutMs: input.config.consoleAgentTimeoutSeconds * 1000
    }
  });
}

export class ConsoleAgentRuntime {
  private readonly activeAgents = new Map<string, Agent>();
  private readonly cancelRequested = new Set<string>();

  constructor(private readonly deps: ConsoleAgentRuntimeDeps) {
    if (!deps.streamFn && !deps.apiKey) {
      throw new ConsoleAgentRuntimeError(
        "Console agent requires CONSOLE_AGENT_API_KEY (an org-scoped API key) outside dev mode."
      );
    }
  }

  async runTurn(input: {
    organizationId: string;
    userId: string;
    conversationId: string;
    text: string;
    pageScope?: Record<string, unknown>;
    onEvent?: (event: ConsoleAgentEmittedEvent) => void;
  }) {
    const started = await this.startTurn(input);
    return started.completion;
  }

  async startTurn(input: {
    organizationId: string;
    userId: string;
    conversationId: string;
    text: string;
    pageScope?: Record<string, unknown>;
    onEvent?: (event: ConsoleAgentEmittedEvent) => void;
  }) {
    const { store } = this.deps;
    const conversation = await store.getConversation(input.organizationId, input.conversationId);
    if (!conversation) {
      throw new ConsoleAgentRuntimeError(`Conversation ${input.conversationId} not found.`);
    }

    const run = await store.startRun({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      actorUserId: input.userId,
      model: this.deps.model.id
    });

    // Persist the user message before the 202 returns so the transcript a
    // client refetches immediately after sending always contains it.
    try {
      await store.appendUserMessage({
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        content: { text: input.text },
        pageScope: input.pageScope
      });
    } catch (error) {
      await store
        .finalizeRun({
          organizationId: input.organizationId,
          runId: run.id,
          actorUserId: input.userId,
          status: "failed",
          error: error instanceof Error ? error.message : "Failed to persist user message."
        })
        .catch(() => undefined);
      throw error;
    }

    const completion = (async () => {
      try {
        return await this.executeTurn(input, conversation.sessionState, run.id);
      } catch (error) {
        await store
          .finalizeRun({
            organizationId: input.organizationId,
            runId: run.id,
            actorUserId: input.userId,
            status: "failed",
            error: error instanceof Error ? error.message : "Console agent run failed."
          })
          .catch(() => undefined);
        throw error;
      } finally {
        this.activeAgents.delete(run.id);
        this.cancelRequested.delete(run.id);
      }
    })();

    return { runId: run.id, completion };
  }

  cancel(runId: string) {
    const agent = this.activeAgents.get(runId);
    if (!agent?.signal) return false;
    this.cancelRequested.add(runId);
    agent.abort();
    return true;
  }

  private async executeTurn(
    input: {
      organizationId: string;
      userId: string;
      conversationId: string;
      text: string;
      pageScope?: Record<string, unknown>;
      onEvent?: (event: ConsoleAgentEmittedEvent) => void;
    },
    sessionState: Record<string, unknown> | null,
    runId: string
  ) {
    const { store } = this.deps;
    const context: CapabilityContext = {
      organizationId: input.organizationId,
      // V1 pins the agent to the org's default workspace; reads, proposals,
      // and held executions all share this scope.
      workspaceId: defaultWorkspaceId(input.organizationId),
      userId: input.userId,
      conversationId: input.conversationId,
      runId
    };
    const policy = new CapabilityPolicy(this.deps.registry, store, this.deps.proposals);
    const sessionMessages = sessionStateMessages(sessionState);
    let askedQuestions: AskedQuestion[] | undefined;
    const agent = new Agent({
      initialState: {
        systemPrompt: buildConsoleAgentSystemPrompt({
          organizationId: input.organizationId,
          capabilities: this.deps.registry.list(),
          pageScope: input.pageScope
        }),
        model: this.deps.model,
        thinkingLevel: this.deps.thinkingLevel,
        tools: [
          ...capabilityTools(policy, context),
          askUserQuestionTool((questions) => {
            askedQuestions = [...(askedQuestions ?? []), ...questions];
          })
        ],
        messages: sessionMessages
      },
      streamFn: this.deps.streamFn,
      getApiKey: this.deps.apiKey ? () => this.deps.apiKey : undefined,
      sessionId: input.conversationId
    });
    this.activeAgents.set(runId, agent);

    const limits = this.deps.limits ?? DEFAULT_RUN_LIMITS;
    let limitError: string | undefined;
    let turnCount = 0;
    let toolCallsThisTurn = 0;
    const enforceLimit = (message: string) => {
      if (limitError) return;
      limitError = message;
      agent.abort();
    };

    let seq = 0;
    let persistenceError: Error | undefined;
    const capabilityKeysByToolName = new Map(
      this.deps.registry.list().map((capability) => [capabilityToolName(capability.key), capability.key])
    );
    // Serializes persist+emit so listeners observe events in seq order even
    // when pi executes tool calls in parallel.
    let tail: Promise<void> = Promise.resolve();
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        toolCallsThisTurn += 1;
        if (toolCallsThisTurn > limits.maxToolCallsPerTurn) {
          enforceLimit(
            `Run stopped: more than ${limits.maxToolCallsPerTurn} tool calls in a single turn.`
          );
        }
      } else if (event.type === "message_end") {
        turnCount += 1;
        toolCallsThisTurn = 0;
        const wantsMoreTools =
          isRecord(event.message) && event.message.stopReason === "toolUse";
        if (turnCount >= limits.maxTurns && wantsMoreTools) {
          enforceLimit(`Run stopped: exceeded the ${limits.maxTurns}-turn limit.`);
        }
      }
      const mapped = mapPiEvent(event);
      if (!mapped) return;
      if (typeof mapped.payload.toolName === "string") {
        mapped.payload.capabilityKey = capabilityKeysByToolName.get(mapped.payload.toolName) ?? null;
      }
      if (mapped.type === "text_delta") {
        input.onEvent?.({ ...mapped, runId });
        return;
      }
      seq += 1;
      const assignedSeq = seq;
      // Redact before emitting so live SSE subscribers see the same
      // reference-serialized payloads that replay serves from the ledger.
      const payload = redactRunEventPayload(mapped.payload);
      const task = tail.then(async () => {
        if (persistenceError) return;
        try {
          await store.appendRunEvent({
            organizationId: input.organizationId,
            runId,
            seq: assignedSeq,
            type: mapped.type,
            payload
          });
          input.onEvent?.({ type: mapped.type, payload, runId, seq: assignedSeq });
        } catch (error) {
          persistenceError = error instanceof Error ? error : new Error("Run event persistence failed.");
          agent.abort();
        }
      });
      tail = task;
      return task;
    });

    const watchdog = setTimeout(() => {
      enforceLimit(
        `Run stopped: exceeded the ${Math.round(limits.timeoutMs / 1000)}s wall-clock limit.`
      );
    }, limits.timeoutMs);
    try {
      await agent.prompt(input.text);
      await agent.waitForIdle();
    } finally {
      clearTimeout(watchdog);
    }
    await tail;

    const cancelled = this.cancelRequested.has(runId);
    const errorMessage = persistenceError?.message ?? limitError ?? agent.state.errorMessage;
    const status = runStatusFor({
      cancelled,
      errorMessage,
      proposalCreated: policy.proposalCreated,
      questionAsked: Boolean(askedQuestions)
    });

    const newMessages = agent.state.messages.slice(sessionMessages.length);
    const assistantMessages = assistantMessageContents(newMessages);
    if (askedQuestions && status === "awaiting_input") {
      assistantMessages.push({ questions: askedQuestions });
    }
    seq += 1;
    const terminal: ConsoleAgentEvent = terminalEventFor(status, errorMessage);
    const finalized = await store.finalizeRun({
      organizationId: input.organizationId,
      runId,
      actorUserId: input.userId,
      status,
      usage: usageTotals(newMessages),
      error: errorMessage,
      assistantMessages,
      sessionState: JSON.parse(JSON.stringify(agent.state.messages)) as unknown[],
      terminalEvent: { seq, type: terminal.type, payload: terminal.payload }
    });
    try {
      input.onEvent?.({
        type: terminal.type,
        payload: redactRunEventPayload(terminal.payload),
        runId,
        seq
      });
    } catch {
      // Listener failures must not reject a successfully finalized run.
    }

    return { run: finalized, status };
  }
}

function runStatusFor(input: {
  cancelled: boolean;
  errorMessage: string | undefined;
  proposalCreated: boolean;
  questionAsked: boolean;
}): ConsoleAgentRunFinalStatus {
  if (input.cancelled) return "cancelled";
  if (input.errorMessage) return "failed";
  if (input.proposalCreated) return "awaiting_approval";
  if (input.questionAsked) return "awaiting_input";
  return "finished";
}

function sessionStateMessages(sessionState: Record<string, unknown> | null): AgentMessage[] {
  if (!sessionState || !Array.isArray(sessionState.messages)) return [];
  return sessionState.messages as AgentMessage[];
}

function assistantMessageContents(messages: AgentMessage[]) {
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const text = joinedAssistantText(message);
    if (text !== undefined) contents.push({ text });
  }
  return contents;
}

function usageTotals(messages: AgentMessage[]) {
  const totals = {
    inputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
  for (const message of messages) {
    if (message.role !== "assistant" || !("usage" in message) || !message.usage) continue;
    totals.inputTokens += message.usage.input ?? 0;
    totals.cachedReadTokens += message.usage.cacheRead ?? 0;
    totals.cachedWriteTokens += message.usage.cacheWrite ?? 0;
    totals.outputTokens += message.usage.output ?? 0;
    totals.totalTokens += message.usage.totalTokens ?? 0;
  }
  return totals;
}
