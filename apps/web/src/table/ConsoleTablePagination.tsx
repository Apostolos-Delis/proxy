import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import { MenuSelect } from "./MenuSelect";

type ConsoleTablePaginationProps = {
  pageIndex: number;
  pageSize: number;
  pageCount: number;
  filteredCount: number;
  totalCount: number;
  pageSizeOptions: number[];
  canPreviousPage: boolean;
  canNextPage: boolean;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
};

export function ConsoleTablePagination({
  pageIndex,
  pageSize,
  pageCount,
  filteredCount,
  totalCount,
  pageSizeOptions,
  canPreviousPage,
  canNextPage,
  onPageChange,
  onPageSizeChange
}: ConsoleTablePaginationProps) {
  const firstRow = filteredCount === 0 ? 0 : pageIndex * pageSize + 1;
  const lastRow = Math.min(filteredCount, (pageIndex + 1) * pageSize);
  const safePageCount = Math.max(1, pageCount);
  const visibleRange = filteredCount === 0 ? "0 rows" : `${firstRow}–${lastRow} of ${filteredCount} rows`;

  return (
    <div className="console-table-pagination">
      <div className="console-table-page-range">
        {visibleRange}
        {filteredCount === totalCount ? null : <span className="faint"> · filtered from {totalCount}</span>}
      </div>
      <div className="console-table-page-controls">
        <span>Rows per page</span>
        <MenuSelect
          value={String(pageSize)}
          options={pageSizeOptions.map((option) => ({ value: String(option), label: String(option) }))}
          ariaLabel="Rows per page"
          className="pagination-size-select"
          onChange={(value) => onPageSizeChange(Number(value))}
        />
        <span className="console-table-page-label">
          Page {pageIndex + 1} <span className="faint">of {safePageCount}</span>
        </span>
        <div className="table-pager">
          <button type="button" aria-label="First page" disabled={!canPreviousPage} onClick={() => onPageChange(0)}>
            <ChevronsLeft />
          </button>
          <button type="button" aria-label="Previous page" disabled={!canPreviousPage} onClick={() => onPageChange(pageIndex - 1)}>
            <ChevronLeft />
          </button>
          <button type="button" aria-label="Next page" disabled={!canNextPage} onClick={() => onPageChange(pageIndex + 1)}>
            <ChevronRight />
          </button>
          <button type="button" aria-label="Last page" disabled={!canNextPage} onClick={() => onPageChange(safePageCount - 1)}>
            <ChevronsRight />
          </button>
        </div>
      </div>
    </div>
  );
}
