import { Inbox, X } from "lucide-react";

type ConsoleTableEmptyStateProps = {
  label: string;
  filtered: boolean;
  onClear: () => void;
};

export function ConsoleTableEmptyState({ label, filtered, onClear }: ConsoleTableEmptyStateProps) {
  return (
    <div className="console-table-empty-state">
      <div className="console-table-empty-icon"><Inbox /></div>
      <strong>{label}</strong>
      <span>{filtered ? "Adjust the search or filters to widen this table." : "Rows will appear here when data starts flowing."}</span>
      {filtered ? (
        <button type="button" className="btn btn-sm" onClick={onClear}>
          <X />Clear filters
        </button>
      ) : null}
    </div>
  );
}
