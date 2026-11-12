import type { ImageElement } from "@/components/slide-editor/types";

export type ImagepitCodeBlockSource = {
  filename: string;
  language: string;
  code: string;
};

export const IMAGEPIT_BLOCK_FRAME = '<!doctype html><html lang="ja"><head><link rel="stylesheet" href="/api/imagepit-block-styles"></head><body style="margin:0"></body></html>';
export const CODE_BLOCK_WIDTH = 560;
export const CODE_BLOCK_MAX_LENGTH = 12000;

export function readImagepitCodeBlock(element: Record<string, unknown> | null) {
  if (element?.type !== "image") return null;
  const source = element.imagepit_code_block;
  if (typeof source !== "object" || source === null) return null;
  if (!("filename" in source) || typeof source.filename !== "string" ||
      !("language" in source) || typeof source.language !== "string" ||
      !("code" in source) || typeof source.code !== "string") return null;
  return { filename: source.filename, language: source.language, code: source.code };
}

export async function captureImagepitCodeBlock(
  node: HTMLElement,
  source: ImagepitCodeBlockSource,
): Promise<ImageElement & { imagepit_code_block: ImagepitCodeBlockSource }> {
  const { toPng } = await import("html-to-image");
  await node.ownerDocument.fonts.ready;
  const width = Math.ceil(Math.max(node.offsetWidth, node.scrollWidth));
  const height = Math.ceil(Math.max(node.offsetHeight, node.scrollHeight));
  if (!width || !height || width > 2048 || height > 4096) {
    throw new Error("The code block is too large. Shorten it or split it across slides.");
  }
  const data = await toPng(node, { width, height, pixelRatio: 2, skipFonts: true });
  return {
    type: "image",
    name: source.filename || "Code Block",
    fit: "contain",
    data,
    size: { width, height },
    imagepit_code_block: source,
  };
}
