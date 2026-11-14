import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles: [module] } = await build({
  stdin: {
    contents: 'export { readImagepitCodeBlock } from "./lib/imagepit-code-block";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { readImagepitCodeBlock } = await import(
  `data:text/javascript;base64,${Buffer.from(module.contents).toString("base64")}`
);

test("reopens command and output sources together, keeping the raw annotations", () => {
  const source = {
    filename: "実行",
    language: "bash",
    style: "slide",
    code: "java Hello # <--[実行]",
    output: {
      language: "bash-stdout",
      title: "実行結果",
      code: "//errorstart\nerror: failed // <--[失敗]\n//errorend",
    },
  };
  const saved = JSON.parse(JSON.stringify({ type: "image", imagepit_code_block: source }));
  assert.deepEqual(readImagepitCodeBlock(saved), source);
});

test("accepts an existing code block without command output", () => {
  const source = { filename: "Hello.java", language: "java", code: "class Hello {}" };
  assert.deepEqual(
    readImagepitCodeBlock({ type: "image", imagepit_code_block: source }),
    { ...source, style: "web" },
  );
});
