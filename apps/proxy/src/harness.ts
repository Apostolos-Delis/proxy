import type { HarnessCompatibilityProfileId } from "@prompt-proxy/schema";

import type { Dialect, Surface } from "./types.js";
import { isRecord } from "./util.js";

export type HarnessName = "claude-code" | "codex" | "opencode" | "cursor" | "generic";

export type HarnessProfileId = HarnessCompatibilityProfileId;

export type HarnessTransport = "http" | "websocket";

export type HarnessSurfaceProfile = {
  readonly id: HarnessProfileId;
  readonly displayName: string;
  readonly harness: HarnessName;
  readonly surface: Surface;
  readonly dialect: Dialect;
  readonly transport: HarnessTransport;
  readonly endpoints: readonly string[];
  readonly sessionKeys: readonly string[];
  readonly requiredRequestFields: readonly string[];
  readonly requiredResponseFields: readonly string[];
  readonly dialectHeaders: readonly string[];
  readonly identityHeaders: readonly string[];
  readonly statefulFeatures: readonly string[];
  readonly unsupportedTranslatedFeatures: readonly string[];
};

export type HarnessProfile = {
  readonly name: HarnessName;
  readonly profiles: readonly HarnessSurfaceProfile[];
  readonly statefulResponses: boolean;
  readonly identityHeaders: readonly string[];
  readonly dialectHeaders: readonly string[];
  readonly promptBlockTags: readonly string[];
  readonly bashToolNames: readonly string[];
  detect(input: HarnessDetectionInput): boolean;
  sessionId(body: unknown, headers: Record<string, string | undefined>): string | undefined;
};

export type HarnessDetectionInput = {
  surface: Surface;
  body: unknown;
  headers: Record<string, string | undefined>;
  transport?: HarnessTransport;
};

const codexIdentityHeaders = [
  "x-codex-turn-state",
  "x-codex-turn-metadata",
  "x-openai-subagent",
  "x-request-id",
  "traceparent",
  "tracestate"
] as const;

const claudeCodeIdentityHeaders = [
  "x-claude-code-session-id",
  "x-claude-code-agent-id",
  "x-claude-code-parent-agent-id",
  "x-request-id",
  "traceparent",
  "tracestate"
] as const;

const opencodeIdentityHeaders = [
  "x-opencode-session-id",
  "x-request-id",
  "traceparent",
  "tracestate"
] as const;

const cursorIdentityHeaders = [
  "x-cursor-session-id",
  "x-cursor-request-id",
  "x-request-id",
  "traceparent",
  "tracestate"
] as const;

const genericIdentityHeaders = ["x-request-id", "traceparent", "tracestate"] as const;
const anthropicDialectHeaders = ["anthropic-version", "anthropic-beta"] as const;
const openAIResponsesDialectHeaders = ["openai-beta"] as const;

export const codexHarness: HarnessProfile = {
  name: "codex",
  profiles: [
    {
      id: "codex-responses-http",
      displayName: "Codex Responses HTTP",
      harness: "codex",
      surface: "openai-responses",
      dialect: "openai-responses",
      transport: "http",
      endpoints: ["/v1/responses"],
      sessionKeys: ["x-codex-session-id", "x-client-request-id", "session_id", "prompt_cache_key", "promptCacheKey"],
      requiredRequestFields: ["model", "input"],
      requiredResponseFields: ["id", "object", "output"],
      dialectHeaders: openAIResponsesDialectHeaders,
      identityHeaders: codexIdentityHeaders,
      statefulFeatures: ["previous_response_id"],
      unsupportedTranslatedFeatures: ["previous_response_id"]
    },
    {
      id: "codex-responses-websocket",
      displayName: "Codex Responses WebSocket",
      harness: "codex",
      surface: "openai-responses",
      dialect: "openai-responses",
      transport: "websocket",
      endpoints: ["/v1/responses"],
      sessionKeys: ["session_id", "x-codex-session-id", "x-client-request-id"],
      requiredRequestFields: ["model", "input"],
      requiredResponseFields: ["id", "object", "output"],
      dialectHeaders: openAIResponsesDialectHeaders,
      identityHeaders: codexIdentityHeaders,
      statefulFeatures: ["previous_response_id", "connection_route"],
      unsupportedTranslatedFeatures: ["websocket_transport", "previous_response_id"]
    }
  ],
  statefulResponses: true,
  identityHeaders: codexIdentityHeaders,
  dialectHeaders: [],
  promptBlockTags: ["environment_context", "user_instructions"],
  bashToolNames: ["shell", "local_shell"],
  detect: ({ surface, body, headers }) =>
    surface === "openai-responses" &&
    (
      hasAnyHeader(headers, [
        "x-codex-session-id",
        "x-codex-turn-state",
        "x-codex-turn-metadata",
        "session_id",
        "x-client-request-id"
      ]) ||
      promptCacheKeyFromBody(body) !== undefined
    ),
  sessionId: (body, headers) =>
    headers["x-codex-session-id"] ?? headers.session_id ?? headers["x-client-request-id"] ??
    promptCacheKeyFromBody(body)
};

export const claudeCodeHarness: HarnessProfile = {
  name: "claude-code",
  profiles: [
    {
      id: "claude-code-messages",
      displayName: "Claude Code Messages",
      harness: "claude-code",
      surface: "anthropic-messages",
      dialect: "anthropic-messages",
      transport: "http",
      endpoints: ["/v1/messages"],
      sessionKeys: ["x-claude-code-session-id", "metadata.user_id"],
      requiredRequestFields: ["model", "messages", "max_tokens"],
      requiredResponseFields: ["id", "type", "role", "content"],
      dialectHeaders: anthropicDialectHeaders,
      identityHeaders: claudeCodeIdentityHeaders,
      statefulFeatures: [],
      unsupportedTranslatedFeatures: []
    }
  ],
  statefulResponses: false,
  identityHeaders: claudeCodeIdentityHeaders,
  dialectHeaders: anthropicDialectHeaders,
  promptBlockTags: ["system-reminder", "command-name", "command-message", "local-command-stdout"],
  bashToolNames: ["Bash", "bash"],
  detect: ({ surface, body, headers }) =>
    surface === "anthropic-messages" &&
    (
      hasAnyHeader(headers, ["x-claude-code-session-id", "x-claude-code-agent-id", "x-claude-code-parent-agent-id"]) ||
      anthropicMetadataSessionId(isRecord(body) ? body.metadata : undefined) !== undefined
    ),
  sessionId: (body, headers) =>
    headers["x-claude-code-session-id"] ??
    anthropicMetadataSessionId(isRecord(body) ? body.metadata : undefined)
};

export const opencodeHarness: HarnessProfile = {
  name: "opencode",
  profiles: [
    {
      id: "opencode-chat",
      displayName: "opencode Chat",
      harness: "opencode",
      surface: "openai-chat",
      dialect: "openai-chat",
      transport: "http",
      endpoints: ["/v1/chat/completions"],
      sessionKeys: ["x-opencode-session-id", "prompt_cache_key", "promptCacheKey"],
      requiredRequestFields: ["model", "messages"],
      requiredResponseFields: ["id", "object", "choices"],
      dialectHeaders: [],
      identityHeaders: opencodeIdentityHeaders,
      statefulFeatures: [],
      unsupportedTranslatedFeatures: []
    }
  ],
  statefulResponses: false,
  identityHeaders: opencodeIdentityHeaders,
  dialectHeaders: [],
  promptBlockTags: ["system-reminder", "command-name", "command-message", "local-command-stdout"],
  bashToolNames: ["bash", "shell", "local_shell"],
  detect: ({ surface, body, headers }) =>
    isOpenAISurface(surface) &&
    (
      hasAnyHeader(headers, ["x-opencode-session-id"]) ||
      headerContains(headers, "user-agent", "opencode") ||
      (surface === "openai-chat" && promptCacheKeyFromBody(body) !== undefined)
    ),
  sessionId: (body, headers) =>
    sessionHeader(headers, ["x-opencode-session-id"]) ??
    promptCacheKeyFromBody(body)
};

export const cursorHarness: HarnessProfile = {
  name: "cursor",
  profiles: [
    {
      id: "cursor-byok-chat",
      displayName: "Cursor BYOK Chat",
      harness: "cursor",
      surface: "openai-chat",
      dialect: "openai-chat",
      transport: "http",
      endpoints: ["/v1/chat/completions"],
      sessionKeys: ["x-cursor-session-id", "cursor-session-id", "metadata.session_id", "metadata.conversation_id"],
      requiredRequestFields: ["model", "messages"],
      requiredResponseFields: ["id", "object", "choices"],
      dialectHeaders: [],
      identityHeaders: cursorIdentityHeaders,
      statefulFeatures: [],
      unsupportedTranslatedFeatures: []
    }
  ],
  statefulResponses: false,
  identityHeaders: cursorIdentityHeaders,
  dialectHeaders: [],
  promptBlockTags: ["system-reminder", "command-name", "command-message", "local-command-stdout"],
  bashToolNames: ["run_terminal_cmd", "shell"],
  detect: ({ surface, body, headers }) =>
    surface === "openai-chat" &&
    (
      cursorSessionId(body, headers) !== undefined ||
      headerContains(headers, "user-agent", "cursor")
    ),
  sessionId: cursorSessionId
};

export const genericHarness: HarnessProfile = {
  name: "generic",
  profiles: [
    {
      id: "openai-chat-sdk",
      displayName: "OpenAI Chat SDK",
      harness: "generic",
      surface: "openai-chat",
      dialect: "openai-chat",
      transport: "http",
      endpoints: ["/v1/chat/completions"],
      sessionKeys: [],
      requiredRequestFields: ["model", "messages"],
      requiredResponseFields: ["id", "object", "choices"],
      dialectHeaders: [],
      identityHeaders: genericIdentityHeaders,
      statefulFeatures: [],
      unsupportedTranslatedFeatures: []
    },
    {
      id: "generic-openai-responses",
      displayName: "Generic OpenAI Responses",
      harness: "generic",
      surface: "openai-responses",
      dialect: "openai-responses",
      transport: "http",
      endpoints: ["/v1/responses"],
      sessionKeys: [],
      requiredRequestFields: ["model", "input"],
      requiredResponseFields: ["id", "object", "output"],
      dialectHeaders: openAIResponsesDialectHeaders,
      identityHeaders: genericIdentityHeaders,
      statefulFeatures: ["previous_response_id"],
      unsupportedTranslatedFeatures: ["previous_response_id"]
    },
    {
      id: "generic-anthropic-messages",
      displayName: "Generic Anthropic Messages",
      harness: "generic",
      surface: "anthropic-messages",
      dialect: "anthropic-messages",
      transport: "http",
      endpoints: ["/v1/messages"],
      sessionKeys: [],
      requiredRequestFields: ["model", "messages", "max_tokens"],
      requiredResponseFields: ["id", "type", "role", "content"],
      dialectHeaders: anthropicDialectHeaders,
      identityHeaders: genericIdentityHeaders,
      statefulFeatures: [],
      unsupportedTranslatedFeatures: []
    }
  ],
  statefulResponses: false,
  identityHeaders: genericIdentityHeaders,
  dialectHeaders: [],
  promptBlockTags: ["system_instruction"],
  bashToolNames: ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"],
  detect: () => true,
  sessionId: () => undefined
};

export const harnessProfiles = [claudeCodeHarness, codexHarness, cursorHarness, opencodeHarness, genericHarness] as const;

export const harnessSurfaceProfiles = harnessProfiles.flatMap((profile) => profile.profiles);

export function harnessSurfaceProfileById(id: HarnessProfileId): HarnessSurfaceProfile {
  const profile = harnessSurfaceProfiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`unknown_harness_surface_profile:${id}`);
  return profile;
}

export function detectHarness(input: HarnessDetectionInput): HarnessProfile {
  return harnessProfiles.find((profile) => profile.detect(input)) ?? genericHarness;
}

export function detectHarnessSurfaceProfile(input: HarnessDetectionInput): HarnessSurfaceProfile {
  const profile = detectHarness(input);
  return harnessSurfaceProfileFor(profile.name, input.surface, input.transport ?? "http");
}

export function harnessSurfaceProfileFor(
  name: HarnessProfile["name"],
  surface: Surface,
  transport: HarnessTransport
): HarnessSurfaceProfile {
  return harnessSurfaceProfiles.find((profile) =>
    profile.harness === name &&
    profile.surface === surface &&
    profile.transport === transport
  ) ?? harnessSurfaceProfiles.find((profile) =>
    profile.harness === name &&
    profile.surface === surface
  ) ?? harnessSurfaceProfiles.find((profile) =>
    profile.harness === "generic" &&
    profile.surface === surface
  ) ?? harnessSurfaceProfileById("generic-openai-responses");
}

export function harnessProfileByName(name: HarnessProfile["name"] | undefined): HarnessProfile {
  return harnessProfiles.find((profile) => profile.name === name) ?? genericHarness;
}

export function promptBlockTagsForSurface(surface: Surface) {
  const tags = new Set<string>(genericHarness.promptBlockTags);
  for (const profile of harnessProfiles) {
    if (profile.name === "generic") continue;
    if (surface === "openai-responses" && profile.name === "codex") {
      for (const tag of profile.promptBlockTags) tags.add(tag);
    }
    if (surface === "anthropic-messages" && profile.name === "claude-code") {
      for (const tag of profile.promptBlockTags) tags.add(tag);
    }
    if (surface === "openai-chat" && (profile.name === "opencode" || profile.name === "cursor")) {
      for (const tag of profile.promptBlockTags) tags.add(tag);
    }
  }
  return tags;
}

export function dialectHeadersFor(dialect: Dialect): readonly string[] {
  if (dialect === "anthropic-messages") return claudeCodeHarness.dialectHeaders;
  if (dialect === "openai-responses") return openAIResponsesDialectHeaders;
  return [];
}

export function identityHeadersFor(profile: Pick<HarnessProfile, "identityHeaders"> | Pick<HarnessSurfaceProfile, "identityHeaders">): readonly string[] {
  return profile.identityHeaders;
}

export function copySelectedHeaders(
  from: Record<string, string | undefined>,
  to: Record<string, string>,
  keys: readonly string[]
) {
  for (const key of keys) copyHeaderIfPresent(from, to, key);
}

export function copyHeaderIfPresent(
  from: Record<string, string | undefined>,
  to: Record<string, string>,
  key: string
) {
  const value = from[key.toLowerCase()] ?? from[key];
  if (value) to[key] = value;
}

export function anthropicMetadataSessionId(metadata: unknown) {
  if (!isRecord(metadata) || typeof metadata.user_id !== "string") return undefined;
  const match = /_session_([0-9a-f][0-9a-f-]{7,})$/i.exec(metadata.user_id);
  return match?.[1];
}

export function promptCacheKeySessionId(value: unknown) {
  if (typeof value !== "string") return undefined;
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : undefined;
}

function promptCacheKeyFromBody(body: unknown) {
  if (!isRecord(body)) return undefined;
  return promptCacheKeySessionId(body.prompt_cache_key) ?? promptCacheKeySessionId(body.promptCacheKey);
}

function cursorSessionId(body: unknown, headers: Record<string, string | undefined>) {
  return sessionHeader(headers, ["x-cursor-session-id", "cursor-session-id"]) ??
    cursorBodySessionId(body);
}

function cursorBodySessionId(body: unknown) {
  if (!isRecord(body)) return undefined;
  const metadata = isRecord(body.metadata) ? body.metadata : undefined;
  return promptCacheKeySessionId(metadata?.session_id) ??
    promptCacheKeySessionId(metadata?.conversation_id) ??
    promptCacheKeySessionId(body.session_id) ??
    promptCacheKeySessionId(body.conversation_id);
}

function sessionHeader(headers: Record<string, string | undefined>, keys: readonly string[]) {
  for (const key of keys) {
    const value = promptCacheKeySessionId(headers[key] ?? headers[key.toLowerCase()]);
    if (value) return value;
  }
  return undefined;
}

function isOpenAISurface(surface: Surface) {
  return surface === "openai-responses" || surface === "openai-chat";
}

function headerContains(headers: Record<string, string | undefined>, key: string, needle: string) {
  return (headers[key] ?? headers[key.toLowerCase()] ?? "").toLowerCase().includes(needle);
}

function hasAnyHeader(headers: Record<string, string | undefined>, keys: readonly string[]) {
  return keys.some((key) => Boolean(headers[key] ?? headers[key.toLowerCase()]));
}
