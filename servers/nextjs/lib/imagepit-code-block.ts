import { readOptionalSize, readString } from "@/components/slide-editor/model/core";
import { loadKonvaImage } from "@/components/slide-editor/surface/exportAssets";
import type { ImageElement } from "@/components/slide-editor/types";

export type ImagepitCodeBlockStyle = "web" | "slide";

export type ImagepitCodeBlockSource = {
  style: ImagepitCodeBlockStyle;
  filename: string;
  language: string;
  code: string;
};

export const IMAGEPIT_BLOCK_FRAME = '<!doctype html><html lang="ja"><head><link rel="stylesheet" href="/api/imagepit-block-styles"></head><body style="margin:0"></body></html>';
export const CODE_BLOCK_WIDTH = 560;
export const CODE_BLOCK_MAX_LENGTH = 12000;
const MAX_WIDTH = 2048;
const MAX_HEIGHT = 4096;

type FrameSize = { width: number; height: number };

export function codeBlockContentScale(frame: FrameSize, raster: FrameSize | null) {
  return raster ? Math.min(frame.width / raster.width, frame.height / raster.height) : 1;
}

export async function resolveCodeBlockRasterSize(element: Record<string, unknown>) {
  const raster = readOptionalSize(element.imagepit_code_raster_size);
  if (raster) return raster;
  const src = readString(element.data);
  const image = src ? await loadKonvaImage(src) : null;
  return image?.naturalWidth && image.naturalHeight
    ? { width: image.naturalWidth / 2, height: image.naturalHeight / 2 }
    : null;
}

export function fitCodeBlockFrame(node: HTMLElement, requested?: FrameSize) {
  const figure = node.querySelector("figure");
  if (!figure) throw new Error("Could not measure the code block.");

  node.style.width = "max-content";
  node.style.removeProperty("padding-top");
  figure.style.removeProperty("min-height");

  // Slide's filename badge is positioned outside the figure's normal flow.
  const badge = node.classList.contains("imagepit-slide-code-block")
    ? figure.querySelector<HTMLElement>(".ui-code-block__header")
    : null;
  const badgeTop = badge
    ? Math.max(0, Math.ceil(node.getBoundingClientRect().top - badge.getBoundingClientRect().top))
    : 0;
  const badgeWidth = badge ? badge.offsetWidth + 2 * badge.offsetLeft + 2 : 0;
  node.style.paddingTop = `${badgeTop}px`;
  const minimum = {
    width: Math.max(node.offsetWidth, badgeWidth),
    height: node.offsetHeight,
  };
  const width = Math.max(minimum.width, Math.min(MAX_WIDTH, Math.round(requested?.width ?? CODE_BLOCK_WIDTH)));
  const height = Math.max(minimum.height, Math.min(MAX_HEIGHT, Math.round(requested?.height ?? 0)));
  node.style.width = `${width}px`;
  figure.style.boxSizing = "border-box";
  figure.style.minHeight = `${height - badgeTop}px`;
  return { width, height, minimum };
}

export function readImagepitCodeBlock(element: Record<string, unknown> | null) {
  if (element?.type !== "image") return null;
  const source = element.imagepit_code_block;
  if (typeof source !== "object" || source === null) return null;
  if (!("filename" in source) || typeof source.filename !== "string" ||
      !("language" in source) || typeof source.language !== "string" ||
      !("code" in source) || typeof source.code !== "string") return null;
  return {
    filename: source.filename,
    language: source.language,
    code: source.code,
    style: "style" in source && source.style === "slide" ? "slide" : "web",
  } satisfies ImagepitCodeBlockSource;
}

export async function captureImagepitCodeBlock(
  node: HTMLElement,
  source: ImagepitCodeBlockSource,
  requested?: FrameSize,
): Promise<ImageElement & {
  size: FrameSize;
  imagepit_code_block: ImagepitCodeBlockSource;
  imagepit_code_min_size: FrameSize;
  imagepit_code_raster_size: FrameSize;
}> {
  const { toPng } = await import("html-to-image");
  await node.ownerDocument.fonts.ready;
  const { width, height, minimum } = fitCodeBlockFrame(node, requested);
  if (!width || !height || width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new Error("The code block is too large. Shorten it or split it across slides.");
  }
  const data = await toPng(node, { width, height, pixelRatio: 2, skipFonts: source.style === "web" });
  return {
    type: "image",
    name: source.filename || "Code Block",
    fit: "contain",
    data,
    size: { width, height },
    imagepit_code_block: source,
    imagepit_code_min_size: minimum,
    imagepit_code_raster_size: { width, height },
  };
}
