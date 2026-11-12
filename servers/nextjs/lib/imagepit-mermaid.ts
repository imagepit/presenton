import { svgToDataUri } from "@/components/slide-editor/surface/exportAssets";

export const MERMAID_SOURCE_LIMIT = 50_000;
export const MERMAID_CSS_LIMIT = 8_000;
const slideFont = "Geist, IBM Plex Sans JP, sans-serif";
const slideMonoFont = "Geist Mono, JetBrains Mono, monospace";

// SVG images cannot inherit CSS variables from the slide canvas.
const slideTheme = {
  "--pele-bg": "transparent",
  "--pele-fg": "#0a0a0a",
  "--pele-line": "#0a0a0a",
  "--pele-muted": "#737373",
  "--pele-surface": "#f5f5f5",
  "--pele-surface-alt": "#fafafa",
  "--pele-border": "#737373",
  "--pele-accent": "#171717",
  "--pele-font": slideFont,
  "--pele-font-mono": slideMonoFont,
};

export function readImagepitMermaid(element: Record<string, unknown> | null) {
  return element?.type === "image" && typeof element.imagepit_mermaid_source === "string"
    ? element.imagepit_mermaid_source
    : null;
}

async function parseMermaidCss(css: string) {
  if (css.length > MERMAID_CSS_LIMIT) throw new Error("Pele CSS variables are too long.");
  if (!css.trim()) return new Map<string, string>();

  const { CssSyntaxError, parse } = await import("postcss");
  try {
    const { nodes: [rule, extra] } = parse(`.diagram {\n${css}\n}`);
    if (rule?.type !== "rule" || rule.selector !== ".diagram" || extra) {
      throw new Error("Enter only Pele CSS variable declarations.");
    }
    const variables = new Map<string, string>();
    for (const node of rule.nodes) {
      if (node.type === "comment") continue;
      if (node.type !== "decl" || node.important ||
          !/^--pele-[a-z][a-z0-9-]*$/.test(node.prop) || !node.value.trim()) {
        const line = (node.source?.start?.line ?? 2) - 1;
        throw new Error(`CSS line ${line}: enter a --pele-* declaration.`);
      }
      variables.set(node.prop, node.value.trim());
    }
    return variables;
  } catch (error) {
    if (!(error instanceof CssSyntaxError)) throw error;
    const line = Math.max(1, Math.min(css.split("\n").length, (error.line ?? 2) - 1));
    throw new Error(`CSS line ${line}: ${error.reason}`);
  }
}

export async function renderImagepitMermaid(source: string, css = "") {
  const variables = await parseMermaidCss(css);
  const { renderAsync } = await import("pele/lazy");
  const { svg } = await renderAsync(source, {
    fontFamily: variables.get("--pele-font") ?? slideFont,
    fontFamilyMono: variables.get("--pele-font-mono") ?? slideMonoFont,
    limit: MERMAID_SOURCE_LIMIT,
    links: false,
    images: false,
    responsive: false,
  });
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const image = document.documentElement;
  if (!(image instanceof SVGSVGElement) || document.querySelector("parsererror")) {
    throw new Error("Pele returned an invalid SVG.");
  }
  for (const [name, value] of Object.entries(slideTheme)) image.style.setProperty(name, value);
  for (const [name, value] of variables) image.style.setProperty(name, value);
  return svgToDataUri(new XMLSerializer().serializeToString(image));
}
