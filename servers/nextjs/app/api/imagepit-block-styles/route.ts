import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";

export async function GET() {
  const packages = join(process.cwd(), "node_modules", "@imagepit");
  const [web, slide, slideFonts] = await Promise.all([
    readFile(join(packages, "web-style/dist/styles.css"), "utf8"),
    readFile(join(packages, "slide-style/dist/layout.css"), "utf8"),
    readFile(join(packages, "slide-style/dist/fonts.css"), "utf8"),
  ]);
  const codeFonts = [...slideFonts.matchAll(/@font-face\s*\{[^}]*font-family:\s*"Geist Mono";[^}]*\}/g)]
    .map(([rule]) => rule)
    .join("\n");
  const css = [
    web,
    slide,
    codeFonts,
    "section.ip-react-slide .imagepit-slide-code-block > figure { margin: 0; }",
  ].join("\n");
  return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
}
