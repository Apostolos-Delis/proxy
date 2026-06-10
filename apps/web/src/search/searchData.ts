import {
  BarChart3,
  CreditCard,
  FileText,
  Gauge,
  GitBranch,
  KeyRound,
  Logs,
  MessagesSquare,
  ScrollText,
  Settings,
  Users
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type SearchHitKind = "session" | "log" | "user" | "routing_config" | "api_key";

export type SearchHit = {
  kind: SearchHitKind;
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  snippet: string | null;
  occurredAt: string | null;
};
import { formatDateTime } from "../format";

export type PalettePagePath =
  | "/"
  | "/usage"
  | "/logs"
  | "/sessions"
  | "/prompts"
  | "/routing-configs"
  | "/api-keys"
  | "/users"
  | "/billing"
  | "/settings";

export type PalettePage = {
  path: PalettePagePath;
  title: string;
  subtitle: string;
  keywords: string[];
  icon: LucideIcon;
};

export type PaletteActionKind = "page" | SearchHitKind;

export type PaletteAction = {
  key: string;
  kind: PaletteActionKind;
  id: string;
  title: string;
  subtitle: string | null;
  status: string | null;
  meta: string | null;
  icon: LucideIcon;
};

export type PaletteGroup = {
  label: string;
  actions: PaletteAction[];
};

export type RecentSearchEntry = {
  kind: PaletteActionKind;
  id: string;
  title: string;
  subtitle: string | null;
};

export type MatchSegment = {
  text: string;
  match: boolean;
};

export const MIN_SEARCH_LENGTH = 2;

export const palettePages: PalettePage[] = [
  { path: "/", title: "Overview", subtitle: "Spend, savings & route quality", keywords: ["dashboard", "home", "metrics", "savings"], icon: Gauge },
  { path: "/usage", title: "Usage", subtitle: "Token metering & spend", keywords: ["tokens", "cost", "spend", "metering", "analytics"], icon: BarChart3 },
  { path: "/logs", title: "Logs", subtitle: "Request stream", keywords: ["requests", "traffic", "prompts", "stream"], icon: Logs },
  { path: "/sessions", title: "Sessions", subtitle: "Agent session replay", keywords: ["replay", "conversations", "agents", "turns"], icon: MessagesSquare },
  { path: "/prompts", title: "Prompts", subtitle: "Captured prompt artifacts", keywords: ["artifacts", "raw text", "capture"], icon: ScrollText },
  { path: "/routing-configs", title: "Routing", subtitle: "Config versions", keywords: ["routes", "configs", "classifier", "models", "versions"], icon: GitBranch },
  { path: "/api-keys", title: "API keys", subtitle: "Manage secrets", keywords: ["secrets", "tokens", "credentials", "keys"], icon: KeyRound },
  { path: "/users", title: "Users", subtitle: "Team & access", keywords: ["team", "members", "access", "roles"], icon: Users },
  { path: "/billing", title: "Billing", subtitle: "Spend & invoices", keywords: ["invoices", "payment", "plan"], icon: CreditCard },
  { path: "/settings", title: "Settings", subtitle: "Runtime configuration", keywords: ["configuration", "budgets", "capture", "retention"], icon: Settings }
];

const kindIcons: Record<PaletteActionKind, LucideIcon> = {
  page: FileText,
  session: MessagesSquare,
  log: Logs,
  user: Users,
  routing_config: GitBranch,
  api_key: KeyRound
};

const hitGroups: { kind: SearchHitKind; label: string }[] = [
  { kind: "log", label: "Logs" },
  { kind: "session", label: "Sessions" },
  { kind: "user", label: "Users" },
  { kind: "routing_config", label: "Routing configs" },
  { kind: "api_key", label: "API keys" }
];

export function buildPaletteGroups(input: {
  query: string;
  hits: SearchHit[];
  recents: RecentSearchEntry[];
}): PaletteGroup[] {
  const query = input.query.trim().toLowerCase();
  if (!query) {
    return withoutEmptyGroups([
      { label: "Recent", actions: input.recents.map(actionForRecent) },
      { label: "Pages", actions: palettePages.map(actionForPage) }
    ]);
  }
  return withoutEmptyGroups([
    { label: "Pages", actions: palettePages.filter((page) => pageMatches(page, query)).map(actionForPage) },
    ...hitGroups.map((group) => ({
      label: group.label,
      actions: input.hits.filter((hit) => hit.kind === group.kind).map(actionForHit)
    }))
  ]);
}

export function matchSegments(text: string, query: string): MatchSegment[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];

  const lower = text.toLowerCase();
  const segments: MatchSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const found = lower.indexOf(needle, cursor);
    if (found === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (found > cursor) segments.push({ text: text.slice(cursor, found), match: false });
    segments.push({ text: text.slice(found, found + needle.length), match: true });
    cursor = found + needle.length;
  }
  return segments;
}

const RECENTS_STORAGE_KEY = "prompt-proxy.search.recents";
const RECENTS_LIMIT = 6;

export function loadRecents(): RecentSearchEntry[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentEntry).slice(0, RECENTS_LIMIT);
  } catch {
    return [];
  }
}

export function rememberRecent(action: PaletteAction) {
  const entry: RecentSearchEntry = {
    kind: action.kind,
    id: action.id,
    title: action.title,
    subtitle: action.subtitle
  };
  const rest = loadRecents().filter((item) => item.kind !== entry.kind || item.id !== entry.id);
  try {
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify([entry, ...rest].slice(0, RECENTS_LIMIT)));
  } catch {
    // Recents are best-effort; ignore storage failures (private mode, quota).
  }
}

function pageMatches(page: PalettePage, query: string) {
  return [page.title, page.subtitle, ...page.keywords]
    .some((value) => value.toLowerCase().includes(query));
}

function actionForPage(page: PalettePage): PaletteAction {
  return {
    key: `page:${page.path}`,
    kind: "page",
    id: page.path,
    title: page.title,
    subtitle: page.subtitle,
    status: null,
    meta: null,
    icon: page.icon
  };
}

function actionForHit(hit: SearchHit): PaletteAction {
  return {
    key: `${hit.kind}:${hit.id}`,
    kind: hit.kind,
    id: hit.id,
    title: hit.snippet ?? hit.title,
    subtitle: hit.subtitle,
    status: visibleStatus(hit.status),
    meta: hit.occurredAt ? formatDateTime(hit.occurredAt) : null,
    icon: kindIcons[hit.kind]
  };
}

function actionForRecent(entry: RecentSearchEntry): PaletteAction {
  const page = entry.kind === "page"
    ? palettePages.find((item) => item.path === entry.id)
    : undefined;
  return {
    key: `recent:${entry.kind}:${entry.id}`,
    kind: entry.kind,
    id: entry.id,
    title: page?.title ?? entry.title,
    subtitle: page?.subtitle ?? entry.subtitle,
    status: null,
    meta: null,
    icon: page?.icon ?? kindIcons[entry.kind]
  };
}

function visibleStatus(status: string | null) {
  if (!status || status === "active" || status === "completed") return null;
  return status;
}

function withoutEmptyGroups(groups: PaletteGroup[]) {
  return groups.filter((group) => group.actions.length > 0);
}

function isRecentEntry(value: unknown): value is RecentSearchEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.kind === "string" &&
    Object.hasOwn(kindIcons, entry.kind) &&
    (entry.subtitle === null || typeof entry.subtitle === "string");
}
