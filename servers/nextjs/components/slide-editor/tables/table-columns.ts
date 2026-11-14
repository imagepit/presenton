export function readTableColumnWidths(value: unknown, count: number): number[] | null {
  if (count < 1 || !Array.isArray(value) || value.length !== count) return null;
  const widths = value.filter(
    (width): width is number =>
      typeof width === "number" && Number.isFinite(width) && width > 0,
  );
  return widths.length === count && Number.isFinite(sum(widths)) ? widths : null;
}

export function fitTableColumnWidths(
  widths: readonly number[],
  tableWidth: number,
): number[] {
  const total = sum(widths);
  return widths.map((width) => (width / total) * tableWidth);
}

export function tableColumnFrames(value: unknown, count: number, tableWidth: number) {
  const widths = readTableColumnWidths(value, count);
  const columns = widths
    ? fitTableColumnWidths(widths, tableWidth)
    : Array.from({ length: count }, () => tableWidth / count);
  let x = 0;
  return columns.map((width) => {
    const frame = { x, width };
    x += width;
    return frame;
  });
}

export function setTableColumnPercent(
  widths: readonly number[],
  index: number,
  percent: number,
): number[] {
  const tableWidth = sum(widths);
  const minimumPercent = minimumTableColumnPercent(widths.length);
  const boundedPercent = Math.min(100 - minimumPercent, Math.max(minimumPercent, percent));
  const target = tableWidth * boundedPercent / 100;
  const otherWidth = tableWidth - widths[index];
  return widths.map((width, columnIndex) =>
    columnIndex === index ? target : (width / otherWidth) * (tableWidth - target),
  );
}

export function minimumTableColumnPercent(count: number) {
  return Math.min(5, 50 / Math.max(1, count));
}

export function resizeTableColumnWidths(value: unknown, scale: number) {
  if (!Array.isArray(value)) return value;
  return readTableColumnWidths(value, value.length)?.map((width) => width * scale) ?? null;
}

function sum(widths: readonly number[]) {
  return widths.reduce((total, width) => total + width, 0);
}
