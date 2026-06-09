import { ArrowDown, ArrowUp, List, SlidersHorizontal } from "lucide-react";
import type { SortingState } from "@tanstack/react-table";

import { MenuSelect } from "./MenuSelect";
import type { ConsoleTableColumnOption } from "./types";

type DisplayOptionsPopoverProps = {
  columns: ConsoleTableColumnOption[];
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  onToggleColumn: (columnId: string) => void;
};

export function DisplayOptionsPopover({ columns, sorting, onSortingChange, onToggleColumn }: DisplayOptionsPopoverProps) {
  const sortableColumns = columns.filter((column) => column.canSort);
  const hideableColumns = columns.filter((column) => column.canHide);
  const activeSort = sorting[0];
  const selectedSortId = activeSort?.id ?? sortableColumns[0]?.id ?? "";
  const selectedSortDesc = activeSort?.desc ?? false;
  return (
    <div className="display-options-popover">
      <div className="display-section">
        <span>View</span>
        <button type="button" className="display-view-option active"><List />List</button>
      </div>
      {sortableColumns.length > 0 ? (
        <div className="display-section">
          <span>Ordering</span>
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
      {hideableColumns.length > 0 ? (
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
