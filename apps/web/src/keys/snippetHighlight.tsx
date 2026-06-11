import type { ReactNode } from "react";

import { highlightJson } from "../jsonView";
import type { SnippetLanguage } from "./setupSnippets";

export function highlightSnippet(text: string, language: SnippetLanguage): ReactNode[] {
  if (language === "json") return highlightJson(text);
  if (language === "toml") return highlightToml(text);
  return highlightShell(text);
}

function byLine(text: string, highlightLine: (line: string, push: Push) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  const push: Push = (chunk, className) => {
    if (chunk === "") return;
    nodes.push(className ? <span key={key++} className={className}>{chunk}</span> : chunk);
  };
  text.split("\n").forEach((line, index) => {
    if (index > 0) push("\n");
    highlightLine(line, push);
  });
  return nodes;
}

type Push = (chunk: string, className?: string) => void;

const PIPE_OPERATORS = new Set(["|", "||", "&&", ";"]);
const REDIRECT_OPERATORS = new Set([">", ">>", "<"]);

// Whitespace, NAME= assignment prefixes, quoted strings (which may contain
// spaces), then everything else word by word.
const SHELL_TOKEN = /(\s+)|([A-Za-z_]\w*=)|('(?:'\\''|[^'])*'?|"(?:\\.|[^"\\])*"?)|([^\s'"]+)/g;

function highlightShell(text: string): ReactNode[] {
  return byLine(text, (line, push) => {
    let expectCommand = true;
    for (const [token, space, assignment, string, word] of line.matchAll(SHELL_TOKEN)) {
      if (space !== undefined) {
        push(token);
      } else if (assignment !== undefined) {
        push(token, "json-key");
        expectCommand = false;
      } else if (string !== undefined) {
        push(token, "json-string");
        expectCommand = false;
      } else if (PIPE_OPERATORS.has(word)) {
        push(token);
        expectCommand = true;
      } else if (REDIRECT_OPERATORS.has(word)) {
        push(token);
      } else if (word.startsWith("-")) {
        push(token, "json-literal");
        expectCommand = false;
      } else if (/^\d+$/.test(word)) {
        push(token, "json-number");
        expectCommand = false;
      } else {
        push(token, expectCommand ? "json-key" : undefined);
        expectCommand = false;
      }
    }
  });
}

function highlightToml(text: string): ReactNode[] {
  return byLine(text, (line, push) => {
    if (/^\s*\[[^\]]*\]\s*$/.test(line)) {
      push(line, "json-literal");
      return;
    }
    const entry = /^(\s*[\w.-]+)(\s*=\s*)(.*)$/.exec(line);
    if (!entry) {
      push(line);
      return;
    }
    push(entry[1], "json-key");
    push(entry[2]);
    const value = entry[3];
    if (value.startsWith('"')) push(value, "json-string");
    else if (value === "true" || value === "false") push(value, "json-literal");
    else if (/^-?\d/.test(value)) push(value, "json-number");
    else push(value);
  });
}
