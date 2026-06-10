import { flexRender, type Table } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { CSSProperties } from "react";

import { ConsoleTableEmptyState } from "./ConsoleTableEmptyState";
import type { ConsoleTableRowProps } from "./types";

type ConsoleTableFrameProps<TData> = {
  table: Table<TData>;
  tableWidth: number;
  emptyLabel: string;
  filtered: boolean;
  getRowProps?: (row: TData) => ConsoleTableRowProps;
  onClear: () => void;
};

export function ConsoleTableFrame<TData>({ table, tableWidth, emptyLabel, filtered, getRowProps, onClear }: ConsoleTableFrameProps<TData>) {
  const rows = table.getRowModel().rows;
  const colSpan = table.getVisibleLeafColumns().length || 1;

  return (
    <div className="console-table-scroll">
      <table className="tbl console-table" style={{ width: tableWidth }}>
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <th key={header.id} style={{ width: header.getSize() }}>
                    <div className={`console-table-th${sorted ? " sorted" : ""}`}>
                      {header.isPlaceholder ? null : (
                        <button type="button" disabled={!header.column.getCanSort()} onClick={header.column.getToggleSortingHandler()}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon sorted={sorted} />
                        </button>
                      )}
                      {header.column.getCanResize() ? (
                        <span
                          role="separator"
                          aria-label={`Resize ${header.column.id} column`}
                          className={`console-column-resizer${header.column.getIsResizing() ? " resizing" : ""}`}
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                        />
                      ) : null}
                    </div>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length > 0 ? rows.map((row, rowIndex) => {
            const rowProps = getRowProps?.(row.original);
            return (
              <tr key={row.id} {...rowProps} className={rowProps?.className} style={{ "--row-i": Math.min(rowIndex, 9) } as CSSProperties}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} style={{ width: cell.column.getSize() }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            );
          }) : (
            <tr className="console-table-empty-row">
              <td colSpan={colSpan}>
                <ConsoleTableEmptyState label={emptyLabel} filtered={filtered} onClear={onClear} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SortIcon({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <ArrowUp />;
  if (sorted === "desc") return <ArrowDown />;
  return <ArrowUpDown />;
}
