import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles: [output] } = await build({
  stdin: {
    contents: `
      export { moveTableBoundary, setTableColumnPercent } from "./components/slide-editor/tables/table-tracks";
      export { formatTableCells } from "./components/slide-editor/tables/table-cell-style";
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { moveTableBoundary, setTableColumnPercent, formatTableCells } = await import(
  `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
);

test("an internal boundary changes only its adjacent tracks", () => {
  assert.deepEqual(moveTableBoundary([100, 100, 100], 2, -40), [100, 60, 140]);
  assert.deepEqual(moveTableBoundary([100, 100, 100], 2, -500), [100, 24, 176]);
  assert.deepEqual(moveTableBoundary([100, 100, 100], 3, 40), [100, 100, 140]);

  const thirdSet = setTableColumnPercent([100, 100, 100], 2, 40);
  assert.deepEqual(setTableColumnPercent(thirdSet, 1, 40), [60, 120, 120]);
});

test("formatting a reversed range preserves other per-run styles and cells", () => {
  const cell = (text) => ({ runs: [
    { text, font: { bold: true, family: "Arial" } },
    { text: " example", font: { italic: true, size: 14 } },
  ] });
  const table = {
    type: "table",
    columns: [cell("A"), cell("B"), cell("C")],
    rows: [[cell("D"), cell("E"), cell("F")]],
  };
  const result = formatTableCells(
    table,
    { elementIndex: 0, rowIndex: 0, colIndex: 0, anchor: { rowIndex: 1, colIndex: 1 } },
    { family: "Space Mono", size: 18 },
  );
  assert.deepEqual(result.columns[0].runs, [
    { text: "A", font: { bold: true, family: "Space Mono", size: 18 } },
    { text: " example", font: { italic: true, family: "Space Mono", size: 18 } },
  ]);
  assert.equal(result.rows[0][1].runs[0].font.family, "Space Mono");
  assert.deepEqual(result.columns[2], table.columns[2]);
  assert.deepEqual(result.rows[0][2], table.rows[0][2]);
});
