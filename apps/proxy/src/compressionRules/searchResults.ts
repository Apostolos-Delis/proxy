import { mapTextContent, type CompressionRule } from "../toolResultCompression.js";

export type SearchResultGroupingCandidate = {
  encoded: string;
  groupCount: number;
  hitCount: number;
};

type SearchHit = {
  line: string;
  column?: string;
  text: string;
};

type SearchGroup = {
  path: string;
  hits: SearchHit[];
};

const DEFAULT_SHELL_TOOL_NAMES = ["Bash", "bash", "shell", "local_shell", "run_terminal_cmd"];
const SEARCH_TOOL_NAMES = ["Search", "Grep", "grep", "rg", "ripgrep"];
const FORMAT = "prompt-proxy.search-result-grouping.v1";

export const searchResultGroupingRule = searchResultGroupingRuleForNames(DEFAULT_SHELL_TOOL_NAMES);

export function searchResultGroupingRuleForNames(shellToolNames: readonly string[]): CompressionRule {
  const toolNames = new Set([...shellToolNames, ...SEARCH_TOOL_NAMES]);
  return {
    label: "search-result-grouping",
    version: 1,
    matches: (toolName) => isSearchTool(toolName, toolNames),
    filter: ({ content }) => mapTextContent(content, groupSearchResults),
    minChars: 512,
    lossy: true
  };
}

export function groupSearchResults(text: string): string | undefined {
  return searchResultGroupingCandidate(text)?.encoded;
}

export function searchResultGroupingCandidate(text: string): SearchResultGroupingCandidate | undefined {
  const original = text.trimEnd();
  if (original.trim().length === 0 || original.includes("\r")) return undefined;
  const lines = original.split("\n");
  if (lines.length < 4 || isNoMatchOutput(lines)) return undefined;

  const groups: SearchGroup[] = [];
  let hitCount = 0;
  for (const line of lines) {
    const parsed = parseSearchHit(line);
    if (!parsed) return undefined;
    const previous = groups[groups.length - 1];
    if (previous && previous.path === parsed.path) {
      previous.hits.push(parsed.hit);
    } else {
      groups.push({ path: parsed.path, hits: [parsed.hit] });
    }
    hitCount += 1;
  }
  if (hitCount < 4 || !groups.some((group) => group.hits.length > 1)) return undefined;

  const encoded = encodeSearchGroups(groups);
  if (encoded.length >= original.length) return undefined;
  return { encoded, groupCount: groups.length, hitCount };
}

function isSearchTool(toolName: string, toolNames: Set<string>) {
  return toolNames.has(toolName) || toolName.startsWith("mcp__github__search") || toolName.startsWith("mcp__gitlab__search");
}

function parseSearchHit(line: string): { path: string; hit: SearchHit } | undefined {
  const match = /^(.+?):(\d+)(?::(\d+))?:(.*)$/.exec(line);
  if (!match) return undefined;
  const [, path, lineNumber, column, text] = match;
  if (!path || lineNumber.length === 0) return undefined;
  return {
    path,
    hit: {
      line: lineNumber,
      ...(column ? { column } : {}),
      text
    }
  };
}

function encodeSearchGroups(groups: SearchGroup[]) {
  const lines = [`[${FORMAT}]`];
  for (const group of groups) {
    lines.push(group.path);
    for (const hit of group.hits) {
      const locator = hit.column ? `${hit.line}:${hit.column}` : hit.line;
      lines.push(`  ${locator}: ${hit.text}`);
    }
  }
  return lines.join("\n");
}

function isNoMatchOutput(lines: string[]) {
  const text = lines.join("\n").trim().toLowerCase();
  return text === "" ||
    text === "no results" ||
    text === "no results found" ||
    text === "no matches" ||
    text === "no matches found";
}
