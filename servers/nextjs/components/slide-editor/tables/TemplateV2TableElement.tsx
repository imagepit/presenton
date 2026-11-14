import { useRef, useState } from "react";
import type Konva from "konva";
import { Group, Line, Rect, Text } from "react-konva";
import type { TableCellAddress, TableCellSelection } from "@/components/slide-editor/state/state";
import type { Size, TableElement, TextRun } from "@/components/slide-editor/types";
import { tableCellRange } from "@/components/slide-editor/tables/table-cell-style";
import { moveTableBoundary, tableTrackFrames } from "@/components/slide-editor/tables/table-tracks";
import { renderMarkdownTextRuns } from "@/components/slide-editor/text/markdown-text";
import {
  layoutRichText,
  renderKonvaTextSegment,
  type RenderTextRun,
} from "@/components/slide-editor/text/template-v2-text";
import { isLatexTextRun } from "@/components/slide-editor/text/text-runs";
import { LatexRunNode } from "@/components/slide-editor/math/LatexRunNode";
import { effectiveLineHeight } from "@/components/slide-editor/text/text-line-height";
import { readableTableTextColor } from "@/components/slide-editor/tables/table-colors";
import { colorWithOpacity } from "@/components/slide-editor/model/render-style";

type UnknownRecord = Record<string, any>;
type RawElement = UnknownRecord;
type RenderTextFont = {
  family: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  lineHeight: number;
  letterSpacing: number;
  opacity: number;
};

type TableTracks = Required<Pick<TableElement, "column_widths" | "row_heights">>;
export type TableResize = (tracks: Partial<TableTracks>, size: Size) => void;

type BoundaryDrag = {
  index: number;
  origin: number;
  sizes: number[];
  next: number[];
};

export function TemplateV2TableElement({
  element,
  width,
  height,
  interactive,
  selectedCell,
  onCellSelect,
  onCellEdit,
  onResize,
}: {
  element: RawElement;
  width: number;
  height: number;
  interactive: boolean;
  selectedCell?: TableCellSelection | null;
  onCellSelect?: (
    rowIndex: number,
    colIndex: number,
    extend?: boolean | TableCellAddress,
  ) => void;
  onCellEdit?: (rowIndex: number, colIndex: number) => void;
  onResize?: TableResize;
}) {
  const rows = rawTableRows(element);
  const rowCount = Math.max(1, rows.length);
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  const group = useRef<Konva.Group>(null);
  const selectionStart = useRef<{
    address: TableCellAddress;
    lastRow: number;
    lastColumn: number;
    moved: boolean;
  } | null>(null);
  const resizeStart = useRef<BoundaryDrag | null>(null);
  const [draft, setDraft] = useState<{
    axis: keyof TableTracks;
    index: number;
    sizes: number[];
  } | null>(null);
  const columnSizes = draft?.axis === "column_widths" ? draft.sizes : element.column_widths;
  const rowSizes = draft?.axis === "row_heights" ? draft.sizes : element.row_heights;
  const tableW = draft?.axis === "column_widths" ? total(draft.sizes) : width;
  const tableH = draft?.axis === "row_heights" ? total(draft.sizes) : height;
  const columns = tableTrackFrames(columnSizes, colCount, tableW);
  const rowFrames = tableTrackFrames(rowSizes, rowCount, tableH);
  const font = rawFont(element);

  function boundaryPosition(axis: keyof TableTracks) {
    const point = group.current?.getRelativePointerPosition();
    return axis === "column_widths" ? point?.x : point?.y;
  }

  function resizeBoundary(axis: keyof TableTracks, index: number) {
    const isColumn = axis === "column_widths";
    const frames = isColumn ? columns : rowFrames;
    const edge = frames[index - 1];
    const position = edge.x + edge.width;
    const startBoundaryDrag = () => {
      const sizes = frames.map((frame) => frame.width);
      resizeStart.current = {
        index,
        origin: boundaryPosition(axis) ?? position,
        sizes,
        next: sizes,
      };
    };
    return (
      <Line
        key={`${axis}-${index}`}
        points={isColumn ? [position, 0, position, tableH] : [0, position, tableW, position]}
        stroke={draft?.axis === axis && draft.index === index ? "#7C51F8" : "transparent"}
        strokeWidth={1}
        hitStrokeWidth={10}
        draggable
        onMouseEnter={(event) => {
          const container = event.target.getStage()?.container();
          if (container) container.style.cursor = isColumn ? "col-resize" : "row-resize";
          event.currentTarget.setAttr("stroke", "#7C51F8");
        }}
        onMouseLeave={(event) => {
          const container = event.target.getStage()?.container();
          if (container) container.style.cursor = "";
          if (!resizeStart.current) event.currentTarget.setAttr("stroke", "transparent");
        }}
        onMouseDown={(event) => {
          event.cancelBubble = true;
          startBoundaryDrag();
        }}
        onTouchStart={(event) => {
          event.cancelBubble = true;
          startBoundaryDrag();
        }}
        onClick={(event) => {
          event.cancelBubble = true;
          resizeStart.current = null;
        }}
        onTap={(event) => {
          event.cancelBubble = true;
          resizeStart.current = null;
        }}
        onDragStart={(event) => {
          event.cancelBubble = true;
          if (!resizeStart.current) startBoundaryDrag();
        }}
        onDragMove={(event) => {
          event.cancelBubble = true;
          event.target.position({ x: 0, y: 0 });
          const drag = resizeStart.current;
          const pointer = boundaryPosition(axis);
          if (!drag || pointer === undefined) return;
          drag.next = moveTableBoundary(drag.sizes, drag.index, pointer - drag.origin);
          setDraft({ axis, index, sizes: drag.next });
        }}
        onDragEnd={(event) => {
          event.cancelBubble = true;
          event.target.position({ x: 0, y: 0 });
          event.currentTarget.setAttr("stroke", "transparent");
          const container = event.target.getStage()?.container();
          if (container) container.style.cursor = "";
          const drag = resizeStart.current;
          resizeStart.current = null;
          setDraft(null);
          if (!drag || drag.next.every((size, i) => size === drag.sizes[i])) return;
          onResize?.({ [axis]: drag.next }, {
            width: isColumn ? total(drag.next) : width,
            height: isColumn ? height : total(drag.next),
          });
        }}
      />
    );
  }

  return (
    <Group ref={group} listening={interactive}>
      {rows.map((row, rowIndex) =>
        columns.map(({ x, width: cellW }, colIndex) => {
          const { x: y, width: cellH } = rowFrames[rowIndex];
          const cell = asRecord(row[colIndex]) ?? {};
          const firstRun = asRecord(readArray(cell.runs)[0]) ?? {};
          const cellFont = fontFromRecord(
            asRecord(cell.font) ?? asRecord(firstRun.font),
            font,
          );
          const forceHeaderBold =
            rowIndex === 0 && !hasExplicitBold(cell, firstRun);
          const fill = fillColor(cell.fill ?? cell.color);
          const rawBorders = asRecord(cell.borders);
          const borders = rawBorders && Object.keys(rawBorders).length > 0
            ? rawBorders
            : null;
          const runs = readableTableCellRuns(
            rawTableCellRuns(cell, cellFont),
            fill,
            rowIndex === 0,
          );
          const renderRuns =
            forceHeaderBold
              ? runs.map((run) => ({
                ...run,
                font: { ...run.font, bold: true },
              }))
              : runs;
          const text = tableCellTextContent(runs);
          const fontSize = cellFont.size;
          const textWidth = Math.max(1, cellW - 12);
          const cellLineHeight = effectiveLineHeight({
            text,
            width: textWidth,
            fontSize,
            lineHeight: cellFont.lineHeight,
            fallback: 1.15,
            wrap: "word",
          });
          return (
            <Group
              key={`${rowIndex}-${colIndex}`}
              x={x}
              y={y}
              onMouseDown={(event) => {
                if (!interactive || event.evt.button !== 0) return;
                event.cancelBubble = true;
                selectionStart.current = {
                  address: { rowIndex, colIndex },
                  lastRow: rowIndex,
                  lastColumn: colIndex,
                  moved: false,
                };
              }}
              onMouseMove={(event) => {
                const start = selectionStart.current;
                if (!interactive || !start || (event.evt.buttons & 1) === 0) return;
                if (start.lastRow === rowIndex && start.lastColumn === colIndex) return;
                start.moved = true;
                start.lastRow = rowIndex;
                start.lastColumn = colIndex;
                onCellSelect?.(rowIndex, colIndex, start.address);
              }}
              onClick={(event) => {
                if (!interactive) return;
                event.cancelBubble = true;
                const moved = selectionStart.current?.moved;
                selectionStart.current = null;
                if (!moved) onCellSelect?.(rowIndex, colIndex, event.evt.shiftKey);
              }}
              onTap={(event) => {
                if (!interactive) return;
                event.cancelBubble = true;
                onCellSelect?.(rowIndex, colIndex);
              }}
              onDblClick={(event) => {
                if (!interactive) return;
                event.cancelBubble = true;
                onCellSelect?.(rowIndex, colIndex);
                onCellEdit?.(rowIndex, colIndex);
              }}
              onDblTap={(event) => {
                if (!interactive) return;
                event.cancelBubble = true;
                onCellSelect?.(rowIndex, colIndex);
                onCellEdit?.(rowIndex, colIndex);
              }}
            >
              <Rect
                width={cellW}
                height={cellH}
                fill={fill ?? "rgba(0,0,0,0)"}
                stroke={borders ? undefined : strokeColor(cell.stroke) ?? "#D0D5DD"}
                strokeWidth={borders ? 0 : strokeWidth(cell.stroke) || 1}
              />
              {borders ? (
                <TableCellBorderLines
                  borders={borders}
                  width={cellW}
                  height={cellH}
                />
              ) : null}
              <TableCellText
                x={6}
                y={4}
                width={textWidth}
                height={Math.max(1, cellH - 8)}
                runs={renderRuns}
                font={forceHeaderBold ? { ...cellFont, bold: true } : cellFont}
                align={readString(cell.alignment) ?? "left"}
                verticalAlign="middle"
                lineHeight={cellLineHeight}
                clip={Array.isArray(rowSizes)}
              />
            </Group>
          );
        }),
      )}
      <SelectedTableCellOutline
        columns={columns}
        rows={rowFrames}
        selectedCell={selectedCell}
      />
      {interactive && onResize && (
        <>
          {columns.map((_, i) => resizeBoundary("column_widths", i + 1))}
          {rowFrames.map((_, i) => resizeBoundary("row_heights", i + 1))}
        </>
      )}
    </Group>
  );
}

function TableCellBorderLines({
  borders,
  width,
  height,
}: {
  borders: UnknownRecord;
  width: number;
  height: number;
}) {
  const sides = [
    ["top", [0, 0, width, 0]],
    ["right", [width, 0, width, height]],
    ["bottom", [0, height, width, height]],
    ["left", [0, 0, 0, height]],
  ] as const;

  return sides.map(([side, points]) => {
    const stroke = asRecord(borders[side]);
    const borderWidth = strokeWidth(stroke);
    const color = colorWithOpacity(
      strokeColor(stroke),
      readNumber(stroke?.opacity) ?? 1,
    );
    if (!stroke || !color || borderWidth <= 0) return null;
    const dash = readArray(stroke.dash)
      .map(readNumber)
      .filter((value): value is number => value != null && value >= 0);
    const lineCap = readString(stroke.line_cap ?? stroke.lineCap);
    const lineJoin = readString(stroke.line_join ?? stroke.lineJoin);
    return (
      <Line
        key={side}
        points={[...points]}
        stroke={color}
        strokeWidth={borderWidth}
        dash={dash.length > 0 ? dash : undefined}
        lineCap={
          lineCap === "butt" || lineCap === "round" || lineCap === "square"
            ? lineCap
            : undefined
        }
        lineJoin={
          lineJoin === "bevel" || lineJoin === "miter" || lineJoin === "round"
            ? lineJoin
            : undefined
        }
        listening={false}
      />
    );
  });
}

function TableCellText({
  x,
  y,
  width,
  height,
  runs,
  font,
  align,
  verticalAlign,
  lineHeight,
  clip,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  runs: RenderTextRun[];
  font: RenderTextFont;
  align: string;
  verticalAlign: string;
  lineHeight: number;
  clip: boolean;
}) {
  const baseFont = { ...font, lineHeight };
  const renderRuns = runs.map((run) => ({
    ...run,
    font: {
      ...run.font,
      lineHeight: run.font.lineHeight || lineHeight,
    },
  }));

  const { tokens } = layoutRichText(
    renderRuns,
    width,
    baseFont,
    align,
    verticalAlign,
    height,
    "word",
  );

  return (
    <Group
      x={x}
      y={y}
      clipWidth={clip ? width : undefined}
      clipHeight={clip ? height : undefined}
      listening={false}
    >
      {tokens.map((token, index) => (
        token.type === "latex" && token.latex ? (
          <LatexRunNode
            key={index}
            x={token.x}
            y={token.y}
            width={token.width}
            height={token.height}
            latex={token.latex}
            displayMode={token.displayMode}
            fontSize={token.font.size}
            color={
              colorWithOpacity(withHash(token.font.color), token.font.opacity) ??
              "#111827"
            }
            interactive={false}
          />
        ) : (
          <Text
            key={index}
            x={token.x}
            y={token.y}
            width={token.width}
            height={token.height}
            text={renderKonvaTextSegment(token.text)}
            fill={colorWithOpacity(withHash(token.font.color), token.font.opacity)}
            fontFamily={`${token.font.family}, Inter`}
            fontSize={token.font.size}
            fontStyle={`${token.font.bold ? "bold" : "normal"} ${token.font.italic ? "italic" : ""
              }`}
            textDecoration={token.font.underline ? "underline" : ""}
            lineHeight={token.font.lineHeight}
            letterSpacing={token.font.letterSpacing}
            wrap="none"
            listening={false}
          />
        )
      ))}
    </Group>
  );
}

function SelectedTableCellOutline({
  columns,
  rows,
  selectedCell,
}: {
  columns: ReturnType<typeof tableTrackFrames>;
  rows: ReturnType<typeof tableTrackFrames>;
  selectedCell?: TableCellSelection | null;
}) {
  if (!selectedCell) return null;
  const range = tableCellRange(selectedCell);
  const left = columns[range.left];
  const right = columns[range.right];
  const top = rows[range.top];
  const bottom = rows[range.bottom];
  if (!left || !right || !top || !bottom) return null;
  const isRange = range.left !== range.right || range.top !== range.bottom;

  return (
    <Rect
      x={left.x}
      y={top.x}
      width={right.x + right.width - left.x}
      height={bottom.x + bottom.width - top.x}
      fill={isRange ? "rgba(124,81,248,0.10)" : "transparent"}
      stroke="#7C51F8"
      strokeWidth={2}
      listening={false}
    />
  );
}

function total(sizes: number[]) {
  return sizes.reduce((sum, size) => sum + size, 0);
}

function rawTableRows(element: RawElement) {
  const columns = readArray(element.columns);
  const rows = readArray(element.rows);
  return [columns, ...rows].filter((row) => Array.isArray(row)) as unknown[][];
}

function rawTableCellRuns(cell: unknown, fallbackFont: RenderTextFont) {
  const sourceRuns = rawTableCellSourceRuns(cell, fallbackFont);
  return renderMarkdownTextRuns(sourceRuns).map((run): RenderTextRun => {
    const font = fontFromRecord(asRecord(run.font), fallbackFont);
    return isLatexTextRun(run)
      ? {
          type: "latex",
          text: run.latex,
          latex: run.latex,
          displayMode: run.display_mode ?? false,
          font,
        }
      : { text: run.text, font };
  });
}

function rawTableCellSourceRuns(
  cell: unknown,
  fallbackFont: RenderTextFont,
): TextRun[] {
  if (typeof cell === "string" || typeof cell === "number") {
    return [{ text: String(cell), font: fontToTextRunFont(fallbackFont) }];
  }
  const record = asRecord(cell);
  if (!record) return [{ text: "", font: fontToTextRunFont(fallbackFont) }];
  const cellFont = fontFromRecord(asRecord(record.font), fallbackFont);
  const runs = readArray(record.runs);
  if (runs.length > 0) {
    return runs
      .map((run) => {
        const runRecord = asRecord(run) ?? {};
        if (readString(runRecord.type) === "latex") {
          const latex = readString(runRecord.latex) ?? "";
          return latex
            ? ({
                type: "latex",
                latex,
                display_mode:
                  readBoolean(runRecord.display_mode ?? runRecord.displayMode) ??
                  false,
                font: fontToTextRunFont(
                  fontFromRecord(asRecord(runRecord.font), cellFont),
                ),
              } satisfies TextRun)
            : null;
        }
        return {
          text: readString(runRecord.text) ?? "",
          font: fontToTextRunFont(
            fontFromRecord(asRecord(runRecord.font), cellFont),
          ),
        };
      })
      .filter(Boolean) as TextRun[];
  }
  const textRecord = asRecord(record.text);
  return [
    {
      text: readString(textRecord?.text) ?? readString(record.text) ?? "",
      font: fontToTextRunFont(cellFont),
    },
  ];
}

function fontToTextRunFont(font: RenderTextFont): TextRun["font"] {
  return {
    family: font.family,
    size: font.size,
    color: font.color,
    bold: font.bold,
    italic: font.italic,
    underline: font.underline,
    line_height: font.lineHeight,
    letter_spacing: font.letterSpacing,
    opacity: font.opacity,
  };
}

function tableCellTextContent(runs: RenderTextRun[]) {
  return runs.map((run) => run.text).join("");
}

function readableTableCellRuns(
  runs: RenderTextRun[],
  fill: string | undefined,
  isHeader: boolean,
) {
  if (isHeader) return runs;
  return runs.map((run) => ({
    ...run,
    font: {
      ...run.font,
      color: readableTableTextColor(run.font.color, fill),
    },
  }));
}

function rawFont(element: RawElement) {
  const font = asRecord(element.font) ?? {};
  return fontFromRecord(font, {
    family: "Arial",
    size: 18,
    color: "#111827",
    bold: false,
    italic: false,
    underline: false,
    lineHeight: 1.15,
    letterSpacing: 0,
    opacity: 1,
  });
}

function fontFromRecord(
  font: UnknownRecord | null,
  fallback: RenderTextFont,
): RenderTextFont {
  return {
    family: readString(font?.family) ?? fallback.family,
    size: readNumber(font?.size) ?? fallback.size,
    color: readString(font?.color) ?? fallback.color,
    bold: readBoolean(font?.bold) ?? fallback.bold,
    italic: readBoolean(font?.italic) ?? fallback.italic,
    underline:
      readBoolean(font?.underline) ??
      (readString(font?.text_decoration) === "underline" ||
        readString(font?.textDecoration) === "underline"
        ? true
        : fallback.underline),
    lineHeight:
      readNumber(font?.line_height) ??
      readNumber(font?.lineHeight) ??
      fallback.lineHeight,
    letterSpacing:
      readNumber(font?.letter_spacing) ??
      readNumber(font?.letterSpacing) ??
      fallback.letterSpacing,
    opacity: readNumber(font?.opacity) ?? fallback.opacity,
  };
}

function hasExplicitBold(cell: UnknownRecord, firstRun: UnknownRecord) {
  return (
    Object.prototype.hasOwnProperty.call(asRecord(cell.font) ?? {}, "bold") ||
    Object.prototype.hasOwnProperty.call(asRecord(firstRun.font) ?? {}, "bold")
  );
}

function fillColor(fill: unknown) {
  const value = asRecord(fill);
  return withHash(readString(value?.color));
}

function strokeColor(stroke: unknown) {
  const value = asRecord(stroke);
  return withHash(readString(value?.color));
}

function strokeWidth(stroke: unknown) {
  const value = asRecord(stroke);
  return readNumber(value?.width) ?? 0;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function withHash(value: string | null | undefined) {
  if (!value) return undefined;
  return value.startsWith("#") || value.startsWith("rgb") ? value : `#${value}`;
}
