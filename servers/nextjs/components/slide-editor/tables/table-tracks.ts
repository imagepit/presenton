export function readTableTrackSizes(value: unknown, count: number): number[] | null {
  if (count < 1 || !Array.isArray(value) || value.length !== count) return null;
  const widths = value.filter(
    (width): width is number =>
      typeof width === "number" && Number.isFinite(width) && width > 0,
  );
  return widths.length === count && Number.isFinite(sum(widths)) ? widths : null;
}

export function fitTableTrackSizes(
  widths: readonly number[],
  tableWidth: number,
): number[] {
  const total = sum(widths);
  return widths.map((width) => (width / total) * tableWidth);
}

export function tableTrackFrames(value: unknown, count: number, tableWidth: number) {
  const widths = readTableTrackSizes(value, count);
  const columns = widths
    ? fitTableTrackSizes(widths, tableWidth)
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
  const boundary = index === 0 ? 1 : index;
  const delta = (tableWidth * percent / 100) - widths[index];
  return moveTableBoundary(widths, boundary, index === 0 ? delta : -delta);
}

export function moveTableBoundary(
  sizes: readonly number[],
  boundary: number,
  delta: number,
): number[] {
  const preceding = sizes[boundary - 1];
  const following = sizes[boundary];
  const minimum = 24;
  const lowerBound = Math.min(preceding, minimum) - preceding;
  const upperBound = following === undefined
    ? Infinity
    : following - Math.min(following, minimum);
  const shift = Math.min(upperBound, Math.max(lowerBound, delta));
  return sizes.map((size, index) => {
    if (index === boundary - 1) return size + shift;
    if (index === boundary) return size - shift;
    return size;
  });
}

export function scaleTableTrackSizes(value: unknown, scale: number) {
  if (!Array.isArray(value)) return value;
  return readTableTrackSizes(value, value.length)?.map((width) => width * scale) ?? null;
}

function sum(widths: readonly number[]) {
  return widths.reduce((total, width) => total + width, 0);
}
