import { isRecord } from "../util.js";

export type SseFrame = {
  event?: string;
  data: string;
};

export type CanonicalToolCall = {
  id?: string;
  name?: string;
  arguments: string;
};

export type CanonicalMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Record<string, unknown>[];
  toolCallId?: string;
  toolCalls?: CanonicalToolCall[];
};

export function cloneRecord(value: unknown): Record<string, unknown> {
  return structuredClone(isRecord(value) ? value : {});
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function integerValue(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function textContent(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textContent).filter(Boolean).join("\n");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return textContent(value.content);
  }
  return JSON.stringify(value);
}

export function jsonArguments(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

export function parseMaybeJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function firstChoice(choices: unknown) {
  if (!Array.isArray(choices)) return undefined;
  return choices.find(isRecord);
}

export async function* transformSse(
  chunks: AsyncIterable<Uint8Array>,
  map: (frame: SseFrame) => string[]
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    const { frames, rest } = drainFrames(buffer);
    buffer = rest;
    for (const frame of frames) {
      const mapped = map(parseFrame(frame));
      for (const out of mapped) yield encoder.encode(out);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const mapped = map(parseFrame(buffer));
    for (const out of mapped) yield encoder.encode(out);
  }
}

export function parseJsonData(frame: SseFrame) {
  try {
    const parsed = JSON.parse(frame.data);
    if (frame.event && isRecord(parsed) && typeof parsed.type !== "string") {
      return { ...parsed, type: frame.event };
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function eventType(event: Record<string, unknown>, frame: SseFrame) {
  return typeof event.type === "string" ? event.type : frame.event;
}

export function formatFrame(frame: SseFrame) {
  const lines = [];
  if (frame.event) lines.push(`event: ${frame.event}`);
  lines.push(`data: ${frame.data}`);
  return `${lines.join("\n")}\n\n`;
}

export function sseFrame(event: string, data: Record<string, unknown>) {
  return formatFrame({ event, data: JSON.stringify(data) });
}

function drainFrames(buffer: string) {
  const frames: string[] = [];
  let rest = buffer;
  while (true) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match) break;
    frames.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  return { frames, rest };
}

function parseFrame(frame: string): SseFrame {
  let event: string | undefined;
  const data = frame
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        return undefined;
      }
      if (line.startsWith("data:")) return line.slice(5).trim();
      return undefined;
    })
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return { event, data };
}
