import { mergeFont } from "@/components/slide-editor/model/element-model";
import type { TableCellSelection, TableSlideElement } from "@/components/slide-editor/state/state";
import type { Font, TableCell } from "@/components/slide-editor/types";

export function tableCellRange({ rowIndex, colIndex, anchor }: TableCellSelection) {
  return {
    top: Math.min(rowIndex, anchor?.rowIndex ?? rowIndex),
    bottom: Math.max(rowIndex, anchor?.rowIndex ?? rowIndex),
    left: Math.min(colIndex, anchor?.colIndex ?? colIndex),
    right: Math.max(colIndex, anchor?.colIndex ?? colIndex),
  };
}

export function hasTableCellRange(selection: TableCellSelection | null): selection is TableCellSelection {
  return Boolean(selection?.anchor && (
    selection.anchor.rowIndex !== selection.rowIndex ||
    selection.anchor.colIndex !== selection.colIndex
  ));
}

export function formatTableCells(
  table: TableSlideElement,
  selection: TableCellSelection,
  patch: Partial<Font>,
): TableSlideElement {
  const { top, bottom, left, right } = tableCellRange(selection);
  const formatRow = (cells: TableCell[], row: number) => {
    if (row < top || row > bottom) return cells;
    const count = Math.max(cells.length, right + 1);
    return Array.from({ length: count }, (_, col) => {
      const cell = cells[col] ?? { runs: [] };
      return col >= left && col <= right ? mergeFont(cell, patch) : cell;
    });
  };

  return {
    ...table,
    columns: formatRow(table.columns, 0),
    rows: table.rows.map((row, index) => formatRow(row, index + 1)),
  };
}

export function selectedTableCellFont(
  table: TableSlideElement,
  selection: TableCellSelection,
): Font {
  const rows = [table.columns, ...table.rows];
  function fontAt(row: number, col: number): Font {
    const cell = rows[row]?.[col];
    return {
      ...table.font,
      bold: row === 0 || table.font?.bold,
      ...cell?.font,
      ...cell?.runs[0]?.font,
    };
  }
  const { top, bottom, left, right } = tableCellRange(selection);
  const fonts = rows.slice(top, bottom + 1).flatMap((_, row) =>
    Array.from({ length: right - left + 1 }, (_, col) => fontAt(top + row, left + col)),
  );
  return {
    ...fontAt(selection.rowIndex, selection.colIndex),
    bold: fonts.every((font) => font.bold === true),
    italic: fonts.every((font) => font.italic === true),
    underline: fonts.every((font) => font.underline === true),
  };
}
