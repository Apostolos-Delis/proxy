import { eq } from "drizzle-orm";

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

type ExtractedPromptArtifact = {
  kind: string;
  content?: string;
  sourceRole?: string;
  sourceIndex?: number;
  metadata?: Record<string, unknown>;
};

export class PromptArtifactStore {
  constructor(
    private readonly db: PromptProxyTransactionalDatabase,
    private readonly readDb: PromptProxyDbSession
  ) {}

  async capture(input: PromptArtifactCaptureInput) {
    const mode = await this.captureMode(input.organizationId);
    if (mode === "none") return [];

    const artifacts = extractPromptArtifacts(input.surface, input.body);
    if (artifacts.length === 0) return [];

    const rows = artifacts.map((artifact) => artifactRow(input, artifact, mode));
    await this.db.transaction(async (tx) => {
      await tx.insert(promptArtifacts).values(rows);
    });
    return rows;
  }

  private async captureMode(organizationId: string): Promise<PromptCaptureMode> {
    const [row] = await this.readDb
      .select({ promptCaptureMode: organizationSettings.promptCaptureMode })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);
    return row?.promptCaptureMode ?? "hash_only";
  }
}

export function extractPromptArtifacts(surface: Surface, body: unknown): ExtractedPromptArtifact[] {
  if (surface === "openai-responses") return extractOpenAIArtifacts(body);
  return extractAnthropicArtifacts(body);
}

function artifactRow(
  input: PromptArtifactCaptureInput,
  artifact: ExtractedPromptArtifact,
  mode: PromptCaptureMode
): typeof promptArtifacts.$inferInsert {
  const metadata = {
    surface: input.surface,
    chars: artifact.content?.length ?? 0,
    ...(artifact.metadata ?? {})
  };
  const rawText = mode === "raw_text" ? artifact.content : undefined;
  const storageMode = rawText === undefined ? "hash_only" : "raw_text";
  return {
    id: createId("prompt_artifact"),
    organizationId: input.organizationId,
    requestId: input.requestId,
    kind: artifact.kind,
    storageMode,
    contentHash: artifact.content === undefined ? sha256(stableJson(metadata)) : sha256(artifact.content),
    rawText,
    tokenEstimate: artifact.content === undefined ? 0 : roughTokenEstimate(artifact.content.length),
    sourceRole: artifact.sourceRole,
    sourceIndex: artifact.sourceIndex,
    metadata
  };
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
