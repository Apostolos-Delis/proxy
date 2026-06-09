import { and, eq, lte } from "drizzle-orm";

import {
  organizationSettings,
  promptArtifacts,
  type PromptProxyDbSession,
  type PromptProxyTransactionalDatabase
} from "@prompt-proxy/db";
import type { PromptCaptureMode } from "@prompt-proxy/schema";

import type { Surface } from "../types.js";
import { createId, isRecord, roughTokenEstimate, sha256, stableJson } from "../util.js";

export type PromptArtifactCaptureInput = {
  organizationId: string;
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
    const rows = artifacts.map((artifact) => artifactRow(input, artifact, settings, now));
    await this.db.transaction(async (tx) => {
      await tx.insert(promptArtifacts).values(rows);
    });
    return rows;
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
      promptCaptureMode: row?.promptCaptureMode ?? "hash_only",
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
  if (surface === "openai-responses") return extractOpenAIArtifacts(body);
  return extractAnthropicArtifacts(body);
}

function artifactRow(
  input: PromptArtifactCaptureInput,
  artifact: ExtractedPromptArtifact,
  settings: PromptCaptureSettings,
  now: Date
): typeof promptArtifacts.$inferInsert {
  const metadata = {
    surface: input.surface,
    chars: artifact.content?.length ?? 0,
    ...(artifact.metadata ?? {})
  };
  const rawText = settings.promptCaptureMode === "raw_text" ? artifact.content : undefined;
  const redactedText = settings.promptCaptureMode === "redacted" && artifact.content !== undefined
    ? "Redacted at capture."
    : undefined;
  const storageMode = storageModeFor(rawText, redactedText);
  return {
    id: createId("prompt_artifact"),
    organizationId: input.organizationId,
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
  pushTextArtifact(artifacts, {
    kind: "instructions",
    content: textContent(request.instructions),
    sourceRole: "system"
  });
  const latestUser = latestOpenAIUserText(request.input);
  if (latestUser) {
    pushTextArtifact(artifacts, {
      kind: "latest_user_message",
      content: latestUser.text,
      sourceRole: "user",
      sourceIndex: latestUser.index
    });
  }
  pushToolMetadata(artifacts, request.tools);
  return artifacts;
}

function extractAnthropicArtifacts(body: unknown): ExtractedPromptArtifact[] {
  const request = isRecord(body) ? body : {};
  const artifacts: ExtractedPromptArtifact[] = [];
  pushTextArtifact(artifacts, {
    kind: "system",
    content: textContent(request.system),
    sourceRole: "system"
  });
  const latestUser = latestAnthropicUserText(request.messages);
  if (latestUser) {
    pushTextArtifact(artifacts, {
      kind: "latest_user_message",
      content: latestUser.text,
      sourceRole: "user",
      sourceIndex: latestUser.index
    });
  }
  pushToolMetadata(artifacts, request.tools);
  return artifacts;
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

function latestOpenAIUserText(input: unknown) {
  if (typeof input === "string") return { text: input, index: 0 };
  if (!Array.isArray(input)) return undefined;

  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item) || item.role !== "user") continue;
    const text = textContent(item.content ?? item.text ?? item.input);
    if (text.trim()) return { text, index };
  }
  return undefined;
}

function latestAnthropicUserText(messages: unknown) {
  if (!Array.isArray(messages)) return undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const text = textContent(message.content);
    if (text.trim()) return { text, index };
  }
  return undefined;
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
