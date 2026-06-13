import { and, eq, inArray, lte } from "drizzle-orm";

import {
  organizationSettings,
  promptArtifacts,
  requests,
  type PromptProxyDbSession,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";
import type { PromptCaptureMode } from "@prompt-proxy/schema";

import { promptBlockTagsForSurface } from "../harness.js";
import type { Surface } from "../types.js";
import { createId, isRecord, roughTokenEstimate, sha256, stableJson, unreachable } from "../util.js";

export type PromptArtifactCaptureInput = {
  organizationId: string;
  workspaceId: string;
  requestId: string;
  surface: Surface;
  body: unknown;
};

export type PromptCaptureSettings = {
  promptCaptureMode: PromptCaptureMode;
  retentionDays: number;
};

type ExtractedPromptArtifact = {
  kind: string;
  content?: string;
  sourceRole?: string;
  sourceIndex?: number;
  metadata?: Record<string, unknown>;
};

export type CapturedPromptArtifact = typeof promptArtifacts.$inferInsert;

export class PromptArtifactStore {
  constructor(
    private readonly db: PromptProxyTransactionalDatabase,
    private readonly readDb: PromptProxyDbSession
  ) {}

  async capture(input: PromptArtifactCaptureInput) {
    const settings = await this.settings(input.organizationId);
    if (settings.promptCaptureMode === "none") return [];

    const artifacts = extractPromptArtifacts(input.surface, input.body);
    if (artifacts.length === 0) return [];

    const now = new Date();
    const candidates = artifacts.map((artifact) => artifactRow(input, artifact, settings, now));
    const captured = new Set(await this.sessionArtifactKeys(input.organizationId, input.requestId));
    const rows: CapturedPromptArtifact[] = [];
    for (const row of candidates) {
      const key = artifactKey(row);
      if (captured.has(key)) continue;
      captured.add(key);
      rows.push(row);
    }
    if (rows.length === 0) return [];

    await this.db.transaction(async (tx) => {
      await tx.insert(promptArtifacts).values(rows);
    });
    return rows;
  }

  // Requests in an agentic session resend the whole conversation each turn.
  // Skip messages already captured by an earlier request of the same session
  // so every artifact marks where its content first appeared.
  private async sessionArtifactKeys(organizationId: string, requestId: string) {
    const [request] = await this.readDb
      .select({ sessionId: requests.sessionId })
      .from(requests)
      .where(and(
        eq(requests.organizationId, organizationId),
        eq(requests.id, requestId)
      ))
      .limit(1);
    if (!request?.sessionId) return [];

    // Includes the current request on purpose: a replayed capture for the
    // same request sees its own committed rows and stays idempotent.
    const siblingRequests = this.readDb
      .select({ id: requests.id })
      .from(requests)
      .where(and(
        eq(requests.organizationId, organizationId),
        eq(requests.sessionId, request.sessionId)
      ));
    const existing = await this.readDb
      .select({
        kind: promptArtifacts.kind,
        contentHash: promptArtifacts.contentHash
      })
      .from(promptArtifacts)
      .where(and(
        eq(promptArtifacts.organizationId, organizationId),
        inArray(promptArtifacts.requestId, siblingRequests)
      ));
    return existing.map((row) => `${row.kind}:${row.contentHash}`);
  }

  async captureResponse(input: {
    organizationId: string;
    workspaceId: string;
    requestId: string;
    surface: Surface;
    text: string;
    truncated?: boolean;
  }) {
    if (!input.text.trim()) return [];
    const settings = await this.settings(input.organizationId);
    if (settings.promptCaptureMode === "none") return [];

    const row = artifactRow(
      input,
      {
        kind: "assistant_response",
        content: input.text,
        sourceRole: "assistant",
        metadata: input.truncated ? { truncated: true } : undefined
      },
      settings,
      new Date()
    );
    // A later request's history capture can land first; skip the duplicate.
    const captured = new Set(await this.sessionArtifactKeys(input.organizationId, input.requestId));
    if (captured.has(artifactKey(row))) return [];
    await this.db.transaction(async (tx) => {
      await tx.insert(promptArtifacts).values([row]);
    });
    return [row];
  }

  async configure(input: {
    organizationId: string;
    promptCaptureMode: PromptCaptureMode;
    retentionDays: number;
  }) {
    const settings = {
      promptCaptureMode: input.promptCaptureMode,
      retentionDays: input.retentionDays,
      updatedAt: new Date()
    };
    await this.readDb
      .insert(organizationSettings)
      .values({
        organizationId: input.organizationId,
        ...settings
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: settings
      });
    return {
      organizationId: input.organizationId,
      promptCaptureMode: input.promptCaptureMode,
      retentionDays: input.retentionDays
    };
  }

  async settings(organizationId: string): Promise<PromptCaptureSettings> {
    const [row] = await this.readDb
      .select({
        promptCaptureMode: organizationSettings.promptCaptureMode,
        retentionDays: organizationSettings.retentionDays
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);
    return {
      promptCaptureMode: row?.promptCaptureMode ?? "raw_text",
      retentionDays: row?.retentionDays ?? 30
    };
  }

  async redactExpired(organizationId: string, now = new Date()) {
    const expired = await this.readDb
      .select({
        id: promptArtifacts.id
      })
      .from(promptArtifacts)
      .where(and(
        eq(promptArtifacts.organizationId, organizationId),
        eq(promptArtifacts.storageMode, "raw_text"),
        lte(promptArtifacts.expiresAt, now)
      ));
    if (expired.length === 0) return { redactedCount: 0 };

    await this.db.transaction(async (tx) => {
      await tx
        .update(promptArtifacts)
        .set({
          storageMode: "redacted",
          rawText: null,
          redactedText: "Redacted by retention policy.",
          encryptedBlobRef: null
        })
        .where(and(
          eq(promptArtifacts.organizationId, organizationId),
          eq(promptArtifacts.storageMode, "raw_text"),
          lte(promptArtifacts.expiresAt, now)
        ));
    });
    return { redactedCount: expired.length };
  }

}

export function promptCaptureEventPayload(surface: Surface, artifacts: CapturedPromptArtifact[]) {
  return {
    surface,
    artifactCount: artifacts.length,
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.id,
      kind: artifact.kind,
      storageMode: artifact.storageMode,
      contentHash: artifact.contentHash,
      tokenEstimate: artifact.tokenEstimate ?? null,
      sourceRole: artifact.sourceRole ?? null,
      sourceIndex: artifact.sourceIndex ?? null,
      metadata: artifact.metadata ?? {}
    }))
  };
}

export function extractPromptArtifacts(surface: Surface, body: unknown): ExtractedPromptArtifact[] {
  switch (surface) {
    case "openai-responses":
      return extractOpenAIArtifacts(body);
    case "openai-chat":
      return extractOpenAIChatArtifacts(body);
    case "anthropic-messages":
      return extractAnthropicArtifacts(body);
    default:
      return unreachable(surface);
  }
}

function artifactKey(row: CapturedPromptArtifact) {
  return `${row.kind}:${row.contentHash}`;
}

export function extractResponseText(surface: Surface, body: unknown): string {
  if (!isRecord(body)) return "";
  switch (surface) {
    case "openai-responses":
      return openAIOutputText(body.output);
    case "openai-chat":
      return openAIChatOutputText(body.choices);
    case "anthropic-messages":
      return anthropicOutputText(body.content);
    default:
      return unreachable(surface);
  }
}

function openAIOutputText(output: unknown) {
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (isRecord(block) && block.type === "output_text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("\n");
}

function openAIChatOutputText(choices: unknown) {
  if (!Array.isArray(choices)) return "";
  const parts: string[] = [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = isRecord(choice.message) ? choice.message : undefined;
    const content = textContent(message?.content);
    if (content) parts.push(content);
  }
  return parts.join("\n");
}

function anthropicOutputText(content: unknown) {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function artifactRow(
  input: Omit<PromptArtifactCaptureInput, "body">,
  artifact: ExtractedPromptArtifact,
  settings: PromptCaptureSettings,
  now: Date
): typeof promptArtifacts.$inferInsert {
  const metadata = {
    surface: input.surface,
    chars: artifact.content?.length ?? 0,
    ...artifact.metadata
  };
  const rawText = settings.promptCaptureMode === "raw_text" ? artifact.content : undefined;
  const redactedText = settings.promptCaptureMode === "redacted" && artifact.content !== undefined
    ? "Redacted at capture."
    : undefined;
  const storageMode = storageModeFor(rawText, redactedText);
  return {
    id: createId("prompt_artifact"),
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    kind: artifact.kind,
    storageMode,
    contentHash: artifact.content === undefined ? sha256(stableJson(metadata)) : sha256(artifact.content),
    rawText,
    redactedText,
    tokenEstimate: artifact.content === undefined ? 0 : roughTokenEstimate(artifact.content.length),
    sourceRole: artifact.sourceRole,
    sourceIndex: artifact.sourceIndex,
    metadata,
    expiresAt: expiry(now, settings.retentionDays)
  };
}

function storageModeFor(rawText: string | undefined, redactedText: string | undefined): PromptCaptureMode {
  if (rawText !== undefined) return "raw_text";
  if (redactedText !== undefined) return "redacted";
  return "hash_only";
}

function expiry(now: Date, retentionDays: number) {
  if (retentionDays <= 0) return now;
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

function extractOpenAIArtifacts(body: unknown): ExtractedPromptArtifact[] {
  const request = isRecord(body) ? body : {};
  const artifacts: ExtractedPromptArtifact[] = [];
  const promptBlockTags = promptBlockTagsForSurface("openai-responses");
  pushTextArtifact(artifacts, {
    kind: "instructions",
    content: textContent(request.instructions),
    sourceRole: "system"
  });
  if (typeof request.input === "string") {
    pushUserBlocks(artifacts, splitInjectedContext(request.input, promptBlockTags), 0);
  } else if (Array.isArray(request.input)) {
    request.input.forEach((item, index) => {
      pushOpenAIInputItem(artifacts, item, index, promptBlockTags);
    });
  }
  pushToolMetadata(artifacts, request.tools);
  return artifacts;
}

function extractOpenAIChatArtifacts(body: unknown): ExtractedPromptArtifact[] {
  const request = isRecord(body) ? body : {};
  const artifacts: ExtractedPromptArtifact[] = [];
  const promptBlockTags = promptBlockTagsForSurface("openai-chat");
  if (Array.isArray(request.messages)) {
    request.messages.forEach((message, index) => {
      pushOpenAIChatMessage(artifacts, message, index, promptBlockTags);
    });
  }
  pushToolMetadata(artifacts, request.tools);
  return artifacts;
}

function pushOpenAIInputItem(
  artifacts: ExtractedPromptArtifact[],
  item: unknown,
  index: number,
  promptBlockTags: ReadonlySet<string>
) {
  if (!isRecord(item)) return;
  if (item.type === "function_call") {
    pushTextArtifact(artifacts, {
      kind: "tool_use",
      content: toolUseText(item.name, item.arguments),
      sourceRole: "assistant",
      sourceIndex: index,
      metadata: { toolName: stringValue(item.name) ?? null }
    });
    return;
  }
  if (item.type === "function_call_output") {
    pushTextArtifact(artifacts, {
      kind: "tool_result",
      content: textContent(item.output),
      sourceRole: "tool",
      sourceIndex: index
    });
    return;
  }
  if (item.type !== undefined && item.type !== "message") return;
  const content = textContent(item.content ?? item.text ?? item.input);
  if (item.role === "user") {
    pushUserBlocks(artifacts, splitInjectedContext(content, promptBlockTags), index);
    return;
  }
  if (item.role === "assistant") {
    pushTextArtifact(artifacts, {
      kind: "assistant_response",
      content,
      sourceRole: "assistant",
      sourceIndex: index
    });
    return;
  }
  if (item.role === "system" || item.role === "developer") {
    pushTextArtifact(artifacts, {
      kind: "instructions",
      content,
      sourceRole: "system",
      sourceIndex: index
    });
  }
}

function pushOpenAIChatMessage(
  artifacts: ExtractedPromptArtifact[],
  message: unknown,
  index: number,
  promptBlockTags: ReadonlySet<string>
) {
  if (!isRecord(message)) return;
  const content = textContent(message.content);
  if (message.role === "user") {
    pushUserBlocks(artifacts, splitInjectedContext(content, promptBlockTags), index);
    return;
  }
  if (message.role === "system" || message.role === "developer") {
    pushTextArtifact(artifacts, {
      kind: "instructions",
      content,
      sourceRole: "system",
      sourceIndex: index
    });
    return;
  }
  if (message.role === "tool") {
    pushTextArtifact(artifacts, {
      kind: "tool_result",
      content,
      sourceRole: "tool",
      sourceIndex: index
    });
    return;
  }
  if (message.role !== "assistant") return;
  pushTextArtifact(artifacts, {
    kind: "assistant_response",
    content,
    sourceRole: "assistant",
    sourceIndex: index
  });
  const toolUses: string[] = [];
  const toolNames: string[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call.function) ? call.function : undefined;
      const name = stringValue(fn?.name) ?? stringValue(call.name);
      toolUses.push(toolUseText(name, fn?.arguments ?? call.arguments));
      if (name) toolNames.push(name);
    }
  }
  pushTextArtifact(artifacts, {
    kind: "tool_use",
    content: toolUses.join("\n\n"),
    sourceRole: "assistant",
    sourceIndex: index,
    metadata: toolNames.length > 0 ? { toolNames } : undefined
  });
}

function extractAnthropicArtifacts(body: unknown): ExtractedPromptArtifact[] {
  const request = isRecord(body) ? body : {};
  const artifacts: ExtractedPromptArtifact[] = [];
  const promptBlockTags = promptBlockTagsForSurface("anthropic-messages");
  pushTextArtifact(artifacts, {
    kind: "system",
    content: textContent(request.system),
    sourceRole: "system"
  });
  if (Array.isArray(request.messages)) {
    request.messages.forEach((message, index) => {
      pushAnthropicMessage(artifacts, message, index, promptBlockTags);
    });
  }
  pushToolMetadata(artifacts, request.tools);
  return artifacts;
}

function pushAnthropicMessage(
  artifacts: ExtractedPromptArtifact[],
  message: unknown,
  index: number,
  promptBlockTags: ReadonlySet<string>
) {
  if (!isRecord(message)) return;
  const blocks = Array.isArray(message.content)
    ? message.content
    : [{ type: "text", text: textContent(message.content) }];
  if (message.role === "user") {
    const texts: string[] = [];
    const toolResults: string[] = [];
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_result") toolResults.push(textContent(block.content));
      else if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
    pushUserBlocks(artifacts, splitInjectedContext(texts.join("\n"), promptBlockTags), index);
    pushTextArtifact(artifacts, {
      kind: "tool_result",
      content: toolResults.join("\n"),
      sourceRole: "tool",
      sourceIndex: index
    });
    return;
  }
  if (message.role !== "assistant") return;
  const texts: string[] = [];
  const toolUses: string[] = [];
  const toolNames: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    if (block.type === "tool_use") {
      toolUses.push(toolUseText(block.name, block.input));
      const name = stringValue(block.name);
      if (name) toolNames.push(name);
    }
  }
  pushTextArtifact(artifacts, {
    kind: "assistant_response",
    content: texts.join("\n"),
    sourceRole: "assistant",
    sourceIndex: index
  });
  pushTextArtifact(artifacts, {
    kind: "tool_use",
    content: toolUses.join("\n\n"),
    sourceRole: "assistant",
    sourceIndex: index,
    metadata: toolNames.length > 0 ? { toolNames } : undefined
  });
}

function splitInjectedContext(text: string, tags: ReadonlySet<string>) {
  const injected: string[] = [];
  const typed: string[] = [];
  const tagPattern = Array.from(tags).map(escapeRegExp).join("|");
  if (!tagPattern) return { typed: text.trim(), injected: "" };
  const blockPattern = new RegExp(`<(${tagPattern})>[\\s\\S]*?<\\/\\1>`, "g");
  let cursor = 0;
  for (const match of text.matchAll(blockPattern)) {
    const before = text.slice(cursor, match.index);
    if (before.trim()) typed.push(before.trim());
    injected.push(match[0]);
    cursor = (match.index ?? 0) + match[0].length;
  }
  const rest = text.slice(cursor);
  if (rest.trim()) typed.push(rest.trim());
  return { typed: typed.join("\n"), injected: injected.join("\n") };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pushUserBlocks(
  artifacts: ExtractedPromptArtifact[],
  split: { typed: string; injected: string },
  index: number
) {
  pushTextArtifact(artifacts, {
    kind: "user_message",
    content: split.typed,
    sourceRole: "user",
    sourceIndex: index
  });
  pushTextArtifact(artifacts, {
    kind: "injected_context",
    content: split.injected,
    sourceRole: "user",
    sourceIndex: index
  });
}

function toolUseText(name: unknown, input: unknown) {
  const label = stringValue(name) ?? "tool";
  if (input === undefined || input === null) return label;
  const args = typeof input === "string" ? input : stableJson(input);
  return `${label} ${args}`;
}

function pushTextArtifact(artifacts: ExtractedPromptArtifact[], artifact: ExtractedPromptArtifact) {
  if (!artifact.content?.trim()) return;
  artifacts.push(artifact);
}

function pushToolMetadata(artifacts: ExtractedPromptArtifact[], tools: unknown) {
  if (!Array.isArray(tools) || tools.length === 0) return;
  artifacts.push({
    kind: "tool_schema_metadata",
    sourceRole: "tool",
    metadata: {
      toolCount: tools.length,
      tools: tools.map((tool) => {
        if (!isRecord(tool)) return { type: typeof tool };
        return {
          type: stringValue(tool.type) ?? null,
          name: stringValue(tool.name) ?? null
        };
      })
    }
  });
}

function textContent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("\n");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return textContent(value.content);
    return stableJson(value);
  }
  return stableJson(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
