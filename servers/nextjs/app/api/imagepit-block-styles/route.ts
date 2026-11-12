import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";

export async function GET() {
  const css = await readFile(
    join(process.cwd(), "node_modules/@imagepit/web-style/dist/styles.css"),
    "utf8",
  );
  return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
}
