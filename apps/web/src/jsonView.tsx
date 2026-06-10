import { Check, Copy } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function highlightJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const [token, string, colon, boolean] = match;
    if (string !== undefined) {
      if (colon !== undefined) {
        nodes.push(<span key={key++} className="json-key">{string}</span>, colon);
      } else {
        nodes.push(<span key={key++} className="json-string">{string}</span>);
      }
    } else if (boolean !== undefined || token === "null") {
      nodes.push(<span key={key++} className="json-literal">{token}</span>);
    } else {
      nodes.push(<span key={key++} className="json-number">{token}</span>);
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function JsonView({ value, maxHeight = 420 }: { value: unknown; maxHeight?: number }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? "null", [value]);
  const nodes = useMemo(() => highlightJson(text), [text]);
  return (
    <div className="json-view">
      <CopyButton text={text} />
      <pre style={{ maxHeight }}>{nodes}</pre>
    </div>
  );
}

export function JsonEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const nodes = useMemo(() => highlightJson(value), [value]);
  return (
    <div className="json-editor">
      <pre aria-hidden>{nodes}{"\n"}</pre>
      <textarea
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy-button${copied ? " copied" : ""}`}
      aria-label={label ?? "Copy to clipboard"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <Check /> : <Copy />}
      {label ? <span>{copied ? "Copied" : label}</span> : null}
    </button>
  );
}
