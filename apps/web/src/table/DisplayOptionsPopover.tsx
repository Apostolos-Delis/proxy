import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import type { SortingState } from "@tanstack/react-table";

import { MenuSelect } from "./MenuSelect";
import type { ConsoleTableColumnOption } from "./types";

type DisplayOptionsPopoverProps = {
  columns: ConsoleTableColumnOption[];
  mode: "sort" | "view";
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  onToggleColumn: (columnId: string) => void;
};

export function DisplayOptionsPopover({ columns, mode, sorting, onSortingChange, onToggleColumn }: DisplayOptionsPopoverProps) {
  const sortableColumns = columns.filter((column) => column.canSort);
  const hideableColumns = columns.filter((column) => column.canHide);
  const activeSort = sorting[0];
  const selectedSortId = activeSort?.id ?? sortableColumns[0]?.id ?? "";
  const selectedSortDesc = activeSort?.desc ?? false;
  return (
    <div className="display-options-popover">
      {mode === "sort" && sortableColumns.length > 0 ? (
        <div className="display-section">
          <span>Sort</span>
          <div className="display-ordering-row">
            <MenuSelect
              value={selectedSortId}
              options={sortableColumns.map((column) => ({ value: column.id, label: column.label }))}
              ariaLabel="Sort column"
              onChange={(id) => onSortingChange([{ id, desc: selectedSortDesc }])}
            />
            <button type="button" className="btn" onClick={() => onSortingChange([{ id: selectedSortId, desc: !selectedSortDesc }])}>
              {selectedSortDesc ? <ArrowDown /> : <ArrowUp />}
              {selectedSortDesc ? "Descending" : "Ascending"}
            </button>
          </div>
        </div>
      ) : null}
      {mode === "view" && hideableColumns.length > 0 ? (
        <div className="display-section">
          <span><SlidersHorizontal />{columns.filter((column) => column.visible).length} columns shown</span>
          <div className="display-columns-grid">
            {hideableColumns.map((column) => (
              <label key={column.id} className="console-column-toggle">
                <input type="checkbox" checked={column.visible} onChange={() => onToggleColumn(column.id)} />
                <span>{column.label}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
