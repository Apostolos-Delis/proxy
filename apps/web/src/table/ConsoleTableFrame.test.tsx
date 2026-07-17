import type { Table } from "@tanstack/react-table";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConsoleTableFrame } from "./ConsoleTableFrame";

type Row = { id: string };

describe("ConsoleTableFrame", () => {
  it("renders an expanded row only when the caller supplies content", () => {
    const collapsed = renderToStaticMarkup(
      <ConsoleTableFrame
        table={tableStub(2)}
        tableWidth={760}
        emptyLabel="Empty"
        filtered={false}
        renderExpandedRow={() => null}
        onClear={() => undefined}
      />
    );
    const expanded = renderToStaticMarkup(
      <ConsoleTableFrame
        table={tableStub(2)}
        tableWidth={760}
        emptyLabel="Empty"
        filtered={false}
        renderExpandedRow={() => <div>Details</div>}
        onClear={() => undefined}
      />
    );

    expect(collapsed).not.toContain("console-table-expanded-row");
    expect(expanded).toContain("console-table-expanded-row");
    expect(expanded).toContain('<td colSpan="2"><div>Details</div></td>');
  });
});

function tableStub(visibleColumnCount: number) {
  const cell = {
    id: "cell-1",
    column: { getSize: () => 120, columnDef: { cell: "Value" } },
    getContext: () => ({})
  };
  return {
    getRowModel: () => ({ rows: [{ id: "row-1", original: { id: "row-1" }, getVisibleCells: () => [cell] }] }),
    getVisibleLeafColumns: () => Array.from({ length: visibleColumnCount }),
    getHeaderGroups: () => []
  } as unknown as Table<Row>;
}
