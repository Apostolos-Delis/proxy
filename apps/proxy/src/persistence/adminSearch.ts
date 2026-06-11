import { and, desc, eq, exists, ilike, isNotNull, notInArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  agentSessions,
  apiKeys,
  organizationMembers,
  promptArtifacts,
  requests,
  routeDecisions,
  routingConfigs,
  users as usersTable,
  type PromptProxyDbSession
} from "@prompt-proxy/db";

import { workspaceScope } from "./scope.js";

export type AdminSearchHit = {
  kind: "session" | "log" | "user" | "routing_config" | "api_key";
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  snippet: string | null;
  occurredAt: string | null;
};

export type AdminSearchResult = {
  query: string;
  results: AdminSearchHit[];
};

const HITS_PER_KIND = 5;
const MIN_QUERY_LENGTH = 2;
const HIDDEN_ARTIFACT_KINDS = ["tool_schema_metadata", "request_input", "assistant_response"];

// Patterns for the two classes of searchable columns. Opaque ids (primary keys,
// request ids) only match queries that look like id fragments — every id contains
// digits or separators, so prose words like "request" stay text-only and do not
// match the shared id prefixes.
type SearchPatterns = {
  text: string;
  id: string | null;
};

export async function searchAdminEntities(
  db: PromptProxyDbSession,
  organizationId: string,
  workspaceId: string,
  rawQuery: string
): Promise<AdminSearchResult> {
  const query = rawQuery.trim();
  if (query.length < MIN_QUERY_LENGTH) return { query, results: [] };

  const text = `%${escapeLikePattern(query)}%`;
  const patterns: SearchPatterns = {
    text,
    id: /[0-9_:-]/.test(query) ? text : null
  };
  const [sessions, logs, users, configs, keys] = await Promise.all([
    searchSessions(db, organizationId, workspaceId, patterns),
    searchLogs(db, organizationId, workspaceId, patterns, query),
    searchUsers(db, organizationId, workspaceId, patterns),
    searchRoutingConfigs(db, organizationId, workspaceId, patterns),
    searchApiKeys(db, organizationId, workspaceId, patterns)
  ]);
  return { query, results: [...sessions, ...logs, ...users, ...configs, ...keys] };
}

function anyOf(conditions: (SQL | null)[]) {
  return or(...conditions.flatMap((condition) => condition ? [condition] : []));
}

async function searchSessions(db: PromptProxyDbSession, organizationId: string, workspaceId: string, patterns: SearchPatterns) {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(
      workspaceScope(agentSessions, organizationId, workspaceId),
      anyOf([
        patterns.id ? ilike(agentSessions.id, patterns.id) : null,
        ilike(agentSessions.externalSessionId, patterns.text),
        ilike(sql`${agentSessions.metadata} ->> 'sessionIdentity'`, patterns.text)
      ])
    ))
    .orderBy(desc(agentSessions.updatedAt))
    .limit(HITS_PER_KIND);

  return rows.map((session): AdminSearchHit => ({
    kind: "session",
    id: session.id,
    title: session.externalSessionId ?? session.id,
    subtitle: [session.surface, session.currentRoute].filter(Boolean).join(" · ") || null,
    status: session.endedAt ? "ended" : "active",
    snippet: null,
    occurredAt: session.updatedAt.toISOString()
  }));
}

async function searchLogs(db: PromptProxyDbSession, organizationId: string, workspaceId: string, patterns: SearchPatterns, query: string) {
  const rows = await db
    .select({
      artifact: promptArtifacts,
      request: requests,
      decision: routeDecisions
    })
    .from(promptArtifacts)
    .innerJoin(requests, and(
      eq(requests.id, promptArtifacts.requestId),
      eq(requests.organizationId, promptArtifacts.organizationId)
    ))
    .leftJoin(routeDecisions, and(
      eq(routeDecisions.requestId, requests.id),
      eq(routeDecisions.organizationId, requests.organizationId)
    ))
    .where(and(
      workspaceScope(promptArtifacts, organizationId, workspaceId),
      notInArray(promptArtifacts.kind, HIDDEN_ARTIFACT_KINDS),
      anyOf([
        patterns.id ? ilike(promptArtifacts.id, patterns.id) : null,
        patterns.id ? ilike(promptArtifacts.requestId, patterns.id) : null,
        ilike(promptArtifacts.rawText, patterns.text),
        ilike(promptArtifacts.redactedText, patterns.text)
      ])
    ))
    .orderBy(desc(promptArtifacts.createdAt))
    .limit(HITS_PER_KIND);

  return rows.map((row): AdminSearchHit => {
    const text = row.artifact.rawText ?? row.artifact.redactedText;
    return {
      kind: "log",
      id: row.artifact.id,
      title: previewText(text) ?? "Prompt not stored",
      subtitle: [
        row.decision?.selectedModel ?? row.request.requestedModel,
        row.decision?.finalRoute
      ].filter(Boolean).join(" · ") || null,
      status: row.request.status,
      snippet: text ? matchSnippet(text, query) : null,
      occurredAt: row.artifact.createdAt.toISOString()
    };
  });
}

async function searchUsers(db: PromptProxyDbSession, organizationId: string, workspaceId: string, patterns: SearchPatterns) {
  const requestRows = db
    .select({ one: sql`1` })
    .from(requests)
    .where(and(
      workspaceScope(requests, organizationId, workspaceId),
      eq(requests.userId, usersTable.id)
    ));
  const rows = await db
    .select({
      user: usersTable,
      member: organizationMembers
    })
    .from(usersTable)
    .leftJoin(organizationMembers, and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.userId, usersTable.id)
    ))
    .where(and(
      or(isNotNull(organizationMembers.userId), exists(requestRows)),
      anyOf([
        patterns.id ? ilike(usersTable.id, patterns.id) : null,
        ilike(usersTable.name, patterns.text),
        ilike(usersTable.email, patterns.text),
        ilike(usersTable.externalId, patterns.text)
      ])
    ))
    .orderBy(desc(usersTable.updatedAt))
    .limit(HITS_PER_KIND);

  return rows.map((row): AdminSearchHit => {
    const title = row.user.name ?? row.user.email ?? row.user.id;
    const subtitleParts = [
      row.user.email && row.user.email !== title ? row.user.email : null,
      row.member?.role ?? null
    ];
    return {
      kind: "user",
      id: row.user.id,
      title,
      subtitle: subtitleParts.filter(Boolean).join(" · ") || null,
      status: row.member?.status ?? null,
      snippet: null,
      occurredAt: row.user.updatedAt.toISOString()
    };
  });
}

async function searchRoutingConfigs(db: PromptProxyDbSession, organizationId: string, workspaceId: string, patterns: SearchPatterns) {
  const rows = await db
    .select()
    .from(routingConfigs)
    .where(and(
      workspaceScope(routingConfigs, organizationId, workspaceId),
      anyOf([
        patterns.id ? ilike(routingConfigs.id, patterns.id) : null,
        ilike(routingConfigs.name, patterns.text),
        ilike(routingConfigs.slug, patterns.text),
        ilike(routingConfigs.description, patterns.text)
      ])
    ))
    .orderBy(desc(routingConfigs.updatedAt))
    .limit(HITS_PER_KIND);

  return rows.map((config): AdminSearchHit => ({
    kind: "routing_config",
    id: config.id,
    title: config.name,
    subtitle: config.description ?? config.slug,
    status: config.status,
    snippet: null,
    occurredAt: config.updatedAt.toISOString()
  }));
}

async function searchApiKeys(db: PromptProxyDbSession, organizationId: string, workspaceId: string, patterns: SearchPatterns) {
  const rows = await db
    .select({
      apiKey: apiKeys,
      routingConfigName: routingConfigs.name
    })
    .from(apiKeys)
    .leftJoin(routingConfigs, and(
      eq(routingConfigs.organizationId, apiKeys.organizationId),
      eq(routingConfigs.id, apiKeys.routingConfigId)
    ))
    .where(and(
      workspaceScope(apiKeys, organizationId, workspaceId),
      anyOf([
        patterns.id ? ilike(apiKeys.id, patterns.id) : null,
        ilike(apiKeys.name, patterns.text)
      ])
    ))
    .orderBy(desc(apiKeys.createdAt))
    .limit(HITS_PER_KIND);

  return rows.map((row): AdminSearchHit => ({
    kind: "api_key",
    id: row.apiKey.id,
    title: row.apiKey.name,
    subtitle: row.routingConfigName,
    status: apiKeyStatus(row.apiKey),
    snippet: null,
    occurredAt: (row.apiKey.lastUsedAt ?? row.apiKey.createdAt).toISOString()
  }));
}

function apiKeyStatus(key: { revokedAt: Date | null; expiresAt: Date | null }) {
  if (key.revokedAt) return "revoked";
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return "expired";
  return "active";
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function previewText(value: string | null | undefined, length = 120) {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > length ? `${collapsed.slice(0, length)}...` : collapsed;
}

function matchSnippet(text: string, query: string, radius = 70) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const index = collapsed.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return null;
  const start = Math.max(0, index - Math.floor(radius / 2));
  const end = Math.min(collapsed.length, index + query.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < collapsed.length ? "..." : "";
  return `${prefix}${collapsed.slice(start, end)}${suffix}`;
}
