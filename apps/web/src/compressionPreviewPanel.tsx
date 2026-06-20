import { useMutation } from "@tanstack/react-query";
import { Search, Zap } from "lucide-react";
import { useState } from "react";

import { formatCompact } from "./format";
import { graphql } from "./gql";
import type { CompressionPreviewPanelQuery } from "./gql/graphql";
import { gqlFetch } from "./graphql";
import { JsonEditor, JsonView } from "./jsonView";
import type { EditableSettings } from "./settingsPageData";
import { DataTable, Segmented, StatusBadge } from "./ui";

type Surface = "anthropic-messages" | "openai-responses" | "openai-chat";
type PreviewResult = CompressionPreviewPanelQuery["compressionPreview"];

const CompressionPreviewPanelDocument = graphql(`
  query CompressionPreviewPanel($input: CompressionPreviewInput!) {
    compressionPreview(input: $input) {
      contentAvailable
      contentRedactionReason
      blocks
      savedBytes
      savedTokens
      previewBlocks {
        blockPath
        toolName
        ruleId
        status
        skipReason
        originalBytes
        compressedBytes
        savedTokens
        diffSegments {
          side
          text
        }
      }
    }
  }
`);

const surfaces = [
  { value: "anthropic-messages", label: "Anthropic" },
  { value: "openai-responses", label: "Responses" },
  { value: "openai-chat", label: "Chat" }
] as const;

const sampleRows = Array.from({ length: 80 }, (_, index) => ({
  id: index,
  title: `issue ${index}`,
  status: index % 3 === 0 ? "open" : "closed",
  labels: ["router", "compression"],
  note: null
}));

const defaultBodies: Record<Surface, string> = {
  "anthropic-messages": JSON.stringify({
    messages: [
      { role: "user", content: "list issues" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__linear__list_issues", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ items: sampleRows }, null, 2) }] }
    ]
  }, null, 2),
  "openai-responses": JSON.stringify({
    input: [
      { type: "function_call", call_id: "c1", name: "mcp__linear__list_issues", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: JSON.stringify({ items: sampleRows }, null, 2) }
    ]
  }, null, 2),
  "openai-chat": JSON.stringify({
    messages: [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "mcp__linear__list_issues", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "c1", content: JSON.stringify({ items: sampleRows }, null, 2) }
    ]
  }, null, 2)
};

export function CompressionPreviewPanel({ policy }: { policy: EditableSettings["toolResultCompressionPolicy"] }) {
  const [surface, setSurface] = useState<Surface>("anthropic-messages");
  const [body, setBody] = useState(defaultBodies["anthropic-messages"]);
  const [parseError, setParseError] = useState<string | null>(null);
  const preview = useMutation({
    mutationFn: async (input: { surface: Surface; body: unknown }) =>
      (await gqlFetch(CompressionPreviewPanelDocument, {
        input: {
          ...input,
          policy
        }
      })).compressionPreview
  });

  function selectSurface(next: Surface) {
    setSurface(next);
    setBody(defaultBodies[next]);
    setParseError(null);
    preview.reset();
  }

  function runPreview() {
    try {
      setParseError(null);
      preview.mutate({ surface, body: JSON.parse(body) });
    } catch {
      setParseError("Invalid JSON body.");
    }
  }

  return (
    <div className="settings-preview-panel">
      <div className="settings-preview-head">
        <strong><Zap />Compression preview</strong>
        <Segmented options={surfaces} value={surface} onChange={selectSurface} />
      </div>
      <JsonEditor value={body} onChange={setBody} />
      <div className="settings-preview-actions">
        <button type="button" className="btn btn-sm" disabled={preview.isPending} onClick={runPreview}>
          <Search />{preview.isPending ? "Previewing" : "Preview"}
        </button>
        {parseError ?? preview.error?.message ? <span className="settings-savebar-error">{parseError ?? preview.error?.message}</span> : null}
      </div>
      {preview.data ? <CompressionPreviewResult preview={preview.data} /> : null}
    </div>
  );
}

function CompressionPreviewResult({ preview }: { preview: PreviewResult }) {
  const firstWithDiff = preview.previewBlocks.find((block) => block.diffSegments.length > 0);
  return (
    <div className="settings-preview-result">
      <div className="settings-preview-summary">
        <span className="mono">{preview.blocks} blocks</span>
        <span className="mono">{formatCompact(preview.savedBytes)} bytes</span>
        <span className="mono">{formatCompact(preview.savedTokens)} tokens</span>
        {!preview.contentAvailable && preview.contentRedactionReason ? <span className="faint">{preview.contentRedactionReason}</span> : null}
      </div>
      {preview.previewBlocks.length > 0 ? (
        <DataTable>
          <thead>
            <tr>
              <th>Status</th>
              <th>Rule</th>
              <th>Tool</th>
              <th>Bytes</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {preview.previewBlocks.map((block) => (
              <tr key={`${block.blockPath}:${block.ruleId}:${block.status}`}>
                <td><StatusBadge status={block.status} /></td>
                <td>
                  <div className="mono">{block.ruleId}</div>
                  {block.skipReason ? <div className="faint">{block.skipReason}</div> : null}
                </td>
                <td>
                  <div className="mono">{block.toolName}</div>
                  <div className="faint">{block.blockPath}</div>
                </td>
                <td className="mono">{formatCompact(block.originalBytes)} -&gt; {formatCompact(block.compressedBytes)}</td>
                <td className="mono">{formatCompact(block.savedTokens)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <div className="empty compact-empty">No compression candidates in this sample.</div>
      )}
      {firstWithDiff ? <JsonView value={firstWithDiff.diffSegments} maxHeight={220} /> : null}
    </div>
  );
}
