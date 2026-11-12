"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { TemplateV2InsertComponent } from "@/components/slide-editor/events/events";
import { svgToDataUri } from "@/components/slide-editor/surface/exportAssets";
import type { Font, SlideElement, Stroke, TableCell } from "@/components/slide-editor/types";
import { imagepitBlockSamples, mermaidSource } from "./imagepit-block-samples";
import { ImagepitCodeBlockView } from "@/components/slide-editor/code-blocks/ImagepitCodeBlockView";
import { captureImagepitCodeBlock, IMAGEPIT_BLOCK_FRAME } from "./imagepit-code-block";

const starterCode = {
  filename: "greet.ts",
  language: "typescript",
  code: 'function greet(name: string) {\n//highlightstart\n  return "Hello, " + name; // <--[Build the greeting]\n//highlightend\n}',
};

export type ImagepitSlideBlock = {
  key: string;
  title: string;
  component: TemplateV2InsertComponent & { size: { width: number; height: number } };
};

function color(value: string) {
  const match = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(value);
  if (!match || (match[4] !== undefined && Number(match[4]) === 0)) return;
  return {
    color: "#" + match.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, "0")).join(""),
    opacity: match[4] === undefined ? undefined : Number(match[4]),
  };
}

function textFont(style: CSSStyleDeclaration): Font {
  const size = parseFloat(style.fontSize);
  return {
    family: style.fontFamily,
    size,
    color: color(style.color)?.color,
    bold: Number(style.fontWeight) >= 600,
    italic: style.fontStyle === "italic",
    line_height: parseFloat(style.lineHeight) / size || 1.2,
    letter_spacing: parseFloat(style.letterSpacing) || 0,
  };
}

function readTableCell(cell: HTMLTableCellElement, win: Window): TableCell {
  const style = win.getComputedStyle(cell);
  const background = color(style.backgroundColor);
  const align = style.textAlign;
  const borderColor = color(style.borderBottomColor);
  return {
    color: background,
    font: textFont(style),
    alignment: align === "center" || align === "right" ? align : "left",
    borders: borderColor && parseFloat(style.borderBottomWidth) > 0
      ? { bottom: { ...borderColor, width: parseFloat(style.borderBottomWidth) } }
      : undefined,
    runs: [{ text: cell.innerText }],
  };
}

function readElements(root: HTMLElement, win: Window & typeof globalThis): SlideElement[] {
  const frame = root.getBoundingClientRect();
  const elements: SlideElement[] = [];
  const visit = (node: Element) => {
    const rect = node.getBoundingClientRect();
    const style = win.getComputedStyle(node);
    if (!rect.width || !rect.height || style.visibility === "hidden") return;

    const x = rect.left - frame.left;
    const y = rect.top - frame.top;
    const position = { x, y };
    const size = { width: rect.width, height: rect.height };
    if (node instanceof win.HTMLTableElement && node.tHead?.rows.length === 1) {
      elements.push({
        type: "table",
        position,
        size,
        columns: Array.from(node.tHead.rows[0].cells, (cell) => readTableCell(cell, win)),
        rows: Array.from(node.tBodies).flatMap((body) =>
          Array.from(body.rows, (row) => Array.from(row.cells, (cell) => readTableCell(cell, win))),
        ),
      });
      return;
    }
    if (node instanceof win.HTMLImageElement) {
      const data = node.getAttribute("src");
      if (data) {
        elements.push({
          type: "image", position, size, data,
          name: node.alt || undefined,
          fit: style.objectFit === "cover" ? "cover" : "contain",
        });
      }
      return;
    }
    if (node instanceof win.SVGSVGElement) {
      const icon = node.cloneNode(true);
      if (icon instanceof win.SVGSVGElement) {
        icon.style.color = style.color;
        elements.push({
          type: "image", position, size,
          data: svgToDataUri(new XMLSerializer().serializeToString(icon)),
        });
      }
      return;
    }
    const fill = color(style.backgroundColor);
    const corners = [
      { x, y }, { x: x + rect.width, y },
      { x: x + rect.width, y: y + rect.height }, { x, y: y + rect.height },
    ];
    const sides = [
      [style.borderTopColor, style.borderTopWidth],
      [style.borderRightColor, style.borderRightWidth],
      [style.borderBottomColor, style.borderBottomWidth],
      [style.borderLeftColor, style.borderLeftWidth],
    ];
    const borders = sides.map(([value, width]): Stroke | undefined => {
      const border = color(value);
      const pixels = parseFloat(width);
      return border && pixels > 0 ? { ...border, width: pixels } : undefined;
    });
    const uniformBorder = sides.every(([value, width]) =>
      value === sides[0][0] && width === sides[0][1],
    );
    const stroke = uniformBorder ? borders[0] : undefined;
    if (fill || stroke) {
      elements.push({
        type: "vector",
        shape: "polygon",
        closed: true,
        points: corners,
        fill,
        stroke,
        corner_radii: [
          style.borderTopLeftRadius, style.borderTopRightRadius,
          style.borderBottomRightRadius, style.borderBottomLeftRadius,
        ].map((radius) => parseFloat(radius) || 0),
      });
    }
    if (!uniformBorder) {
      borders.forEach((edge, index) => {
        if (!edge) return;
        elements.push({
          type: "vector",
          shape: "polygon",
          points: [corners[index], corners[(index + 1) % corners.length]],
          stroke: edge,
        });
      });
    }

    for (const child of node.childNodes) {
      if (child instanceof win.Element) {
        visit(child);
        continue;
      }
      if (child.nodeType !== Node.TEXT_NODE) continue;
      const source = child.textContent ?? "";
      const pre = node.closest("pre");
      const text = pre ? source : source.trim();
      if (!text.trim()) continue;
      const range = node.ownerDocument.createRange();
      range.selectNode(child);
      const bounds = range.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      const font = textFont(style);
      const size = font.size ?? 16;
      elements.push({
        type: "text",
        position: { x: bounds.left - frame.left, y: bounds.top - frame.top },
        size: {
          width: Math.max(
            bounds.width + 2,
            (pre?.getBoundingClientRect().right ?? rect.right) - bounds.left,
          ),
          height: Math.max(bounds.height, size * (font.line_height ?? 1.2)),
        },
        font,
        runs: [{ text }],
      });
    }
  };
  for (const child of root.children) visit(child);
  return elements;
}

function ignoreCodePreviewError() {}

export function ImagepitBlockSource({
  onReady,
}: {
  onReady: (blocks: ImagepitSlideBlock[]) => void;
}) {
  const [doc, setDocument] = useState<Document | null>(null);
  const [codeBlock, setCodeBlock] = useState<ImagepitSlideBlock | null>(null);
  const captureStarter = useCallback((node: HTMLElement) => {
    void captureImagepitCodeBlock(node, starterCode).then((element) => {
      if (!node.isConnected || !element.size) return;
      setCodeBlock({
        key: "code-block",
        title: "Code Block",
        component: {
          id: "imagepit-code-block",
          description: "IMAGEPIT Code Block",
          position: { x: 40, y: 40 },
          size: element.size,
          elements: [{ ...element, position: { x: 0, y: 0 } }],
        },
      });
    }).catch(() => {
      if (node.isConnected) setCodeBlock(null);
    });
  }, []);
  const [diagram, setDiagram] = useState<string | null>(null);
  const diagramId = `imagepit-mermaid-${useId().replace(/[^a-z0-9-]/gi, "")}`;
  const samples = useMemo(() => imagepitBlockSamples(diagram), [diagram]);

  useEffect(() => {
    let active = true;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        if (!active) return;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", flowchart: { htmlLabels: false } });
        const { svg } = await mermaid.render(diagramId, mermaidSource);
        if (active) setDiagram(svgToDataUri(svg));
      })
      .catch(() => {
        // The source remains editable if the diagram renderer is unavailable.
      });
    return () => { active = false; };
  }, [diagramId]);
  useLayoutEffect(() => {
    if (!doc) return;
    const win = doc.defaultView;
    if (!win) return;
    let active = true;
    void doc.fonts.ready.then(() => {
      if (!active) return;
      const blocks = samples.flatMap(({ key, title }) => {
        const root = doc.getElementById(key);
        if (!root) return [];
        const elements = readElements(root, win);
        return elements.length ? [{
          key,
          title,
          component: {
            id: `imagepit-${key}`,
            description: `IMAGEPIT ${title}`,
            position: { x: 40, y: 40 },
            size: { width: root.offsetWidth, height: root.offsetHeight },
            elements,
          },
        }] : [];
      });
      onReady(codeBlock ? [codeBlock, ...blocks] : blocks);
    });
    return () => { active = false; };
  }, [codeBlock, doc, onReady, samples]);

  return (
    <>
      <iframe
        title="IMAGEPIT block layout source"
        aria-hidden="true"
        sandbox="allow-same-origin"
        tabIndex={-1}
        style={{ position: "fixed", left: -10000, width: 640, height: 720, visibility: "hidden", border: 0 }}
        srcDoc={IMAGEPIT_BLOCK_FRAME}
        onLoad={(event) => setDocument(event.currentTarget.contentDocument)}
      />
      {doc?.body && createPortal(
        <>
          <ImagepitCodeBlockView source={starterCode} onReady={captureStarter} onError={ignoreCodePreviewError} />
          {samples.map(({ key, view }) => <section key={key} id={key} style={{ width: 560 }}>{view}</section>)}
        </>,
        doc.body,
      )}
    </>
  );
}
