import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ChevronLeft,
  ChevronRight,
  Columns3,
  MoreVertical,
  Plus,
  Rows3,
  Settings,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  TableCellSelection,
  TableSlideElement,
} from "@/components/slide-editor/state/state";
import { withHash } from "@/components/slide-editor/utils/color";
import {
  elementBox,
  setTableRowsFromStrings,
  tableRowsAsStrings,
} from "@/components/slide-editor/model/element-model";
import type { TableCell } from "@/components/slide-editor/types";
import {
  fitTableColumnWidths,
  minimumTableColumnPercent,
  readTableColumnWidths,
  setTableColumnPercent,
  tableColumnFrames,
} from "@/components/slide-editor/tables/table-columns";
import { DeferredColorInput } from "@/components/slide-editor/toolbar/DeferredColorInput";
import {
  FloatingToolbar,
  FloatingToolbarPanel,
  type FloatingToolbarBox,
} from "@/components/slide-editor/toolbar/FloatingToolbar";

type TableCellAlignment = NonNullable<TableCell["alignment"]>;

const TABLE_CELL_ALIGNMENTS = [
  "left",
  "center",
  "right",
  "justify",
] as const satisfies readonly TableCellAlignment[];

export function TableToolbarControls({
  element,
  index,
  selectedCell,
  onChange,
}: {
  element: TableSlideElement;
  index: number;
  selectedCell: TableCellSelection | null;
  onChange: (index: number, element: TableSlideElement) => void;
}) {
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const rows = tableRowsAsStrings(element);
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const activeRow = Math.min(
    rows.length - 1,
    Math.max(0, selectedCell?.rowIndex ?? 0),
  );
  const activeColumn = Math.min(
    columnCount - 1,
    Math.max(0, selectedCell?.colIndex ?? 0),
  );
  const activeCell =
    activeRow === 0
      ? element.columns[activeColumn]
      : element.rows[activeRow - 1]?.[activeColumn];
  const activeCellFillColor =
    activeCell?.color?.color ??
    (activeCell as TableCell & { fill?: { color?: string | null } | null })
      ?.fill?.color;
  const colorPickerValue = activeCellFillColor ?? "FFFFFF";
  const activeCellAlignment: TableCellAlignment =
    activeCell?.alignment ?? "left";
  const ActiveCellAlignmentIcon =
    activeCellAlignment === "center"
      ? AlignCenter
      : activeCellAlignment === "right"
        ? AlignRight
        : activeCellAlignment === "justify"
          ? AlignJustify
          : AlignLeft;
  const canAddRow = rows.length < 8;
  const tableWidth = Math.max(1, elementBox(element).w);
  const savedWidths = readTableColumnWidths(element.column_widths, columnCount);
  const columnWidths = tableColumnFrames(
    savedWidths,
    columnCount,
    tableWidth,
  ).map((column) => column.width);
  const columnPercent =
    Math.round((columnWidths[activeColumn] / tableWidth) * 1000) / 10;
  const canAddColumn = columnCount < 6;
  const canDeleteRow = rows.length > 2;
  const canDeleteColumn = columnCount > 1;
  const canMoveColumnLeft = activeColumn > 0;
  const canMoveColumnRight = activeColumn < columnCount - 1;

  useEffect(() => {
    if (!tableMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-inline-edit-ignore='true']")) return;
      if (toolbarRef.current?.contains(event.target as Node)) return;
      setTableMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [tableMenuOpen]);

  const normalizeRows = (nextRows: string[][]) =>
    nextRows.map((row) =>
      Array.from({ length: columnCount }, (_, colIndex) => row[colIndex] ?? ""),
    );

  const commitRows = (nextRows: string[][]) => {
    onChange(index, setTableRowsFromStrings(element, nextRows));
  };

  const addRow = () => {
    if (!canAddRow) return;
    const nextRows = normalizeRows(rows);
    const insertIndex = Math.min(nextRows.length, activeRow + 1);
    nextRows.splice(
      insertIndex,
      0,
      Array.from({ length: columnCount }, () => ""),
    );
    commitRows(nextRows);
  };

  const deleteRow = () => {
    if (!canDeleteRow) return;
    const nextRows = normalizeRows(rows);
    nextRows.splice(activeRow, 1);
    commitRows(nextRows);
  };

  const updateColumns = (change: (indices: (number | null)[]) => void) => {
    const indices: (number | null)[] = Array.from(
      { length: columnCount },
      (_, columnIndex) => columnIndex,
    );
    change(indices);
    const updateCells = (cells: TableCell[]) =>
      indices.map((oldIndex) =>
        (oldIndex === null ? undefined : cells[oldIndex]) ?? { runs: [] },
      );
    onChange(index, {
      ...element,
      columns: updateCells(element.columns),
      rows: element.rows.map(updateCells),
      column_widths: savedWidths
        ? fitTableColumnWidths(
            indices.map((oldIndex) =>
              oldIndex === null ? tableWidth / columnCount : columnWidths[oldIndex],
            ),
            tableWidth,
          )
        : null,
    });
  };

  const addColumn = () => {
    if (!canAddColumn) return;
    updateColumns((indices) => {
      indices.splice(activeColumn + 1, 0, null);
    });
  };

  const deleteColumn = () => {
    if (!canDeleteColumn) return;
    updateColumns((indices) => {
      indices.splice(activeColumn, 1);
    });
  };

  const moveColumn = (direction: "left" | "right") => {
    const targetColumn =
      direction === "left" ? activeColumn - 1 : activeColumn + 1;
    if (targetColumn < 0 || targetColumn >= columnCount) return;
    updateColumns((indices) => {
      [indices[activeColumn], indices[targetColumn]] = [
        indices[targetColumn],
        indices[activeColumn],
      ];
    });
  };

  const updateColumnWidth = (percent: number) => {
    if (!Number.isFinite(percent) || percent === columnPercent) return;
    onChange(index, {
      ...element,
      column_widths: setTableColumnPercent(columnWidths, activeColumn, percent),
    });
    setTableMenuOpen(false);
  };

  const updateActiveCell = (
    patchCell: (cell: TableCell | undefined) => TableCell,
  ) => {
    if (activeRow === 0) {
      onChange(index, {
        ...element,
        columns: element.columns.map((cell, colIndex) =>
          colIndex === activeColumn ? patchCell(cell) : cell,
        ),
      });
      return;
    }

    onChange(index, {
      ...element,
      rows: element.rows.map((row, rowIndex) =>
        rowIndex === activeRow - 1
          ? Array.from(
            { length: columnCount },
            (_, colIndex) =>
              colIndex === activeColumn
                ? patchCell(row[colIndex])
                : row[colIndex] ?? { runs: [] },
          )
          : row,
      ),
    });
  };

  const updateActiveCellFillColor = (color: string) => {
    updateActiveCell((cell) => ({
      ...(cell ?? { runs: [] }),
      color: {
        ...(cell?.color ?? {}),
        color,
      },
    }));
  };
  const cycleActiveCellAlignment = () => {
    const activeIndex = TABLE_CELL_ALIGNMENTS.indexOf(activeCellAlignment);
    const nextAlignment =
      TABLE_CELL_ALIGNMENTS[
      (activeIndex + 1) % TABLE_CELL_ALIGNMENTS.length
      ] ?? "left";
    updateActiveCell((cell) => ({
      ...(cell ?? { runs: [] }),
      alignment: nextAlignment,
    }));
  };
  const resetColumnWidths = () => {
    onChange(index, { ...element, column_widths: null });
  };
  const runTableMenuAction = (action: () => void) => {
    action();
    setTableMenuOpen(false);
  };

  return (
    <div ref={toolbarRef} style={tableControlsStyle}>
      <button
        type="button"
        aria-label="Cell background color"
        title="Cell background"
        style={iconButtonStyle}
        onClick={() => colorInputRef.current?.click()}
      >
        <span
          style={{
            ...colorDotStyle,
            background: activeCellFillColor
              ? withHash(activeCellFillColor)
              : "transparent",
          }}
        />
        <DeferredColorInput
          ref={colorInputRef}
          aria-hidden="true"
          tabIndex={-1}
          value={colorPickerValue}
          onCommit={updateActiveCellFillColor}
          style={hiddenColorInputStyle}
        />
      </button>
      <Divider />
      <button
        type="button"
        aria-label="Table alignment"
        title={`Align ${nextAlignmentLabel(activeCellAlignment)}`}
        style={iconButtonStyle}
        onClick={cycleActiveCellAlignment}
      >
        <ActiveCellAlignmentIcon size={16} strokeWidth={1.33} />
      </button>
      <Divider />
      <button
        type="button"
        aria-label="Delete row"
        title="Delete row"
        disabled={!canDeleteRow}
        style={{
          ...iconButtonStyle,
          opacity: canDeleteRow ? 1 : 0.36,
          cursor: canDeleteRow ? "pointer" : "not-allowed",
        }}
        onClick={deleteRow}
      >
        <Trash2 size={16} strokeWidth={1.33} />
      </button>
      <Divider />
      <button
        type="button"
        aria-label="Table cell actions"
        aria-expanded={tableMenuOpen}
        title="Table cell actions"
        style={{
          ...iconButtonStyle,
          ...(tableMenuOpen ? activeButtonStyle : null),
        }}
        onClick={() => setTableMenuOpen((open) => !open)}
      >
        <Settings size={16} strokeWidth={1.33} />
      </button>
      <TableToolbarMenu
        canAddColumn={canAddColumn}
        canAddRow={canAddRow}
        canDeleteColumn={canDeleteColumn}
        canDeleteRow={canDeleteRow}
        canMoveColumnLeft={canMoveColumnLeft}
        canMoveColumnRight={canMoveColumnRight}
        menuOpen={tableMenuOpen}
        columnCount={columnCount}
        columnPercent={columnPercent}
        columnIndex={activeColumn}
        onChangeColumnWidth={updateColumnWidth}
        onResetColumnWidths={
          savedWidths ? () => runTableMenuAction(resetColumnWidths) : undefined
        }
        onAddColumn={() => runTableMenuAction(addColumn)}
        onAddRow={() => runTableMenuAction(addRow)}
        onDeleteColumn={() => runTableMenuAction(deleteColumn)}
        onDeleteRow={() => runTableMenuAction(deleteRow)}
        onMoveColumnLeft={() => runTableMenuAction(() => moveColumn("left"))}
        onMoveColumnRight={() => runTableMenuAction(() => moveColumn("right"))}
      />
    </div>
  );
}

export function TableToolbar({
  anchorBox,
  element,
  index,
  scale,
  selectedCell,
  onChange,
}: {
  anchorBox?: FloatingToolbarBox | null;
  element: TableSlideElement;
  index: number;
  scale: number;
  selectedCell: TableCellSelection | null;
  onChange: (index: number, element: TableSlideElement) => void;
}) {
  const box = elementBox(element);

  return (
    <FloatingToolbar
      anchorBox={
        anchorBox ?? {
          x: box.x * scale,
          y: box.y * scale,
          width: box.w * scale,
          height: box.h * scale,
        }
      }
      fallbackWidth={290}
      inlineEditIgnore
    >
      <div style={standaloneToolbarStyle}>
        <TableToolbarControls
          element={element}
          index={index}
          selectedCell={selectedCell}
          onChange={onChange}
        />
      </div>
    </FloatingToolbar>
  );
}

function TableToolbarMenu({
  canAddColumn,
  canAddRow,
  canDeleteColumn,
  canDeleteRow,
  canMoveColumnLeft,
  canMoveColumnRight,
  menuOpen,
  columnCount,
  columnPercent,
  columnIndex,
  onChangeColumnWidth,
  onResetColumnWidths,
  onAddColumn,
  onAddRow,
  onDeleteColumn,
  onDeleteRow,
  onMoveColumnLeft,
  onMoveColumnRight,
}: {
  canAddColumn: boolean;
  canAddRow: boolean;
  canDeleteColumn: boolean;
  canDeleteRow: boolean;
  canMoveColumnLeft: boolean;
  canMoveColumnRight: boolean;
  menuOpen: boolean;
  columnCount: number;
  columnPercent: number;
  columnIndex: number;
  onChangeColumnWidth: (percent: number) => void;
  onResetColumnWidths?: () => void;
  onAddColumn: () => void;
  onAddRow: () => void;
  onDeleteColumn: () => void;
  onDeleteRow: () => void;
  onMoveColumnLeft: () => void;
  onMoveColumnRight: () => void;
}) {
  if (!menuOpen) return null;
  const minimum = minimumTableColumnPercent(columnCount);

  return (
    <FloatingToolbarPanel style={menuStyle}>
      <MenuItem
        disabled={!canDeleteRow}
        icon={<Rows3 size={20} strokeWidth={2.2} />}
        label="Delete Row"
        onClick={onDeleteRow}
      />
      <MenuItem
        disabled={!canDeleteColumn}
        icon={<Columns3 size={20} strokeWidth={2.2} />}
        label="Delete Column"
        onClick={onDeleteColumn}
      />
      <MenuItem
        disabled={!canAddRow}
        icon={<Plus size={20} strokeWidth={2.4} />}
        label="Add Row"
        onClick={onAddRow}
      />
      <MenuItem
        disabled={!canAddColumn}
        icon={<Plus size={20} strokeWidth={2.4} />}
        label="Add Column"
        onClick={onAddColumn}
      />
      {columnCount > 1 ? (
        <>
          <div style={menuDividerStyle} />
          <form
            key={columnIndex}
            style={{ ...menuItemStyle, gap: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              const width = new FormData(event.currentTarget).get("width");
              onChangeColumnWidth(Number(width));
            }}
          >
            <label style={{ display: "flex", flex: 1, alignItems: "center", gap: 8 }}>
              Column width
              <input
                name="width"
                type="number"
                required
                min={minimum}
                max={100 - minimum}
                step="any"
                defaultValue={columnPercent}
                style={{
                  width: 55,
                  padding: "3px 4px",
                  border: "1px solid #D0D5DD",
                  borderRadius: 4,
                }}
              />
              %
            </label>
            <button
              type="submit"
              aria-label="Apply column width"
              style={{ ...iconButtonStyle, width: "auto", padding: "0 4px" }}
            >
              Apply
            </button>
          </form>
          {onResetColumnWidths ? (
            <MenuItem label="Equal column widths" onClick={onResetColumnWidths} />
          ) : null}
        </>
      ) : null}
      <div style={menuDividerStyle} />
      <MenuItem
        disabled={!canMoveColumnRight}
        icon={<ChevronRight size={20} strokeWidth={2.4} />}
        label="Move Column Right"
        onClick={onMoveColumnRight}
      />
      <MenuItem
        disabled={!canMoveColumnLeft}
        icon={<ChevronLeft size={20} strokeWidth={2.4} />}
        label="Move Column Left"
        onClick={onMoveColumnLeft}
      />
    </FloatingToolbarPanel>
  );
}

function MenuItem({
  disabled = false,
  icon,
  label,
  shortcut,
  strong = false,
  onClick,
}: {
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  shortcut?: string;
  strong?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      style={{
        ...menuItemStyle,
        ...(strong ? strongMenuItemStyle : null),
        opacity: disabled ? 0.38 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      onClick={() => {
        if (disabled) return;
        onClick();
      }}
    >
      {icon ? <span style={menuIconStyle}>{icon}</span> : null}
      <span>{label}</span>
      {shortcut ? <span style={menuShortcutStyle}>{shortcut}</span> : null}
    </button>
  );
}

function Divider() {
  return <span aria-hidden="true" style={dividerStyle} />;
}

function nextAlignmentLabel(alignment: TableCellAlignment) {
  const activeIndex = TABLE_CELL_ALIGNMENTS.indexOf(alignment);
  return (
    TABLE_CELL_ALIGNMENTS[
    (activeIndex + 1) % TABLE_CELL_ALIGNMENTS.length
    ] ?? "left"
  );
}

const standaloneToolbarStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  borderRadius: 14,
  border: "1px solid #E7E8EC",
  background: "#FFFFFF",
  boxShadow: "0 12px 32px rgba(15, 23, 42, 0.18)",
};

const tableControlsStyle: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  height: 28,
  color: "#191919",
  fontFamily:
    "syne, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

const iconButtonStyle: CSSProperties = {
  position: "relative",
  width: 28,
  height: 28,
  border: 0,
  borderRadius: 6,
  background: "transparent",
  color: "#0F172A",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  padding: 0,
};

const activeButtonStyle: CSSProperties = {
  background: "#F6F3FF",
};

const dividerStyle: CSSProperties = {
  width: 1,
  height: 28,
  margin: "0 8px",
  background: "#E7E8EC",
};

const colorDotStyle: CSSProperties = {
  width: 16,
  height: 16,
  boxSizing: "border-box",
  borderRadius: 999,
  border: "1px solid rgba(15, 23, 42, 0.26)",
  boxShadow:
    "inset 0 0 0 1px rgba(255, 255, 255, 0.68), 0 1px 3px rgba(15, 23, 42, 0.22)",
  display: "block",
};

const hiddenColorInputStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  opacity: 0,
  pointerEvents: "none",
};

const menuStyle: CSSProperties = {
  width: 260,
  padding: "14px 0",
  borderRadius: 14,
  border: "1px solid #E7E8EC",
  background: "#FFFFFF",
  boxShadow: "0 20px 52px rgba(15, 23, 42, 0.22)",
};

const menuItemStyle: CSSProperties = {
  width: "100%",
  height: 44,
  border: 0,
  background: "transparent",
  color: "#191919",
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "0 24px",
  fontSize: 15,
  fontWeight: 500,
  letterSpacing: 0,
  textAlign: "left",
};

const strongMenuItemStyle: CSSProperties = {
  color: "#000000",
};

const menuIconStyle: CSSProperties = {
  width: 22,
  height: 22,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#111827",
};

const menuShortcutStyle: CSSProperties = {
  marginLeft: "auto",
  padding: "4px 6px",
  borderRadius: 6,
  background: "#F6F6F9",
  color: "#808080",
  fontSize: 12,
  lineHeight: 1,
  whiteSpace: "nowrap",
};

const menuDividerStyle: CSSProperties = {
  height: 1,
  margin: "10px 0",
  background: "#ECEDEF",
};
