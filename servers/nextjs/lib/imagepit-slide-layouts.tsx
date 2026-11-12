"use client";

import {
  ContentSlide,
  SectionStartSlide,
  SlideFrame,
  TitleCoverSlide,
  type SlideFrameLayout,
} from "@imagepit/slide-react";
import "@imagepit/slide-style/layout.css";
import "@imagepit/slide-style/fonts.css";
import { useLayoutEffect, useRef } from "react";
import type { RawElement } from "@/components/slide-editor/model/core";

const layouts = [
  { kind: "title-cover", name: "表紙", title: "プレゼンテーションのタイトル", lead: "サブタイトルを入力" },
  { kind: "section-start", name: "章扉", title: "章のタイトル", lead: "章の概要を入力" },
  { kind: "content", name: "本文", title: "スライドのタイトル", lead: "本文を入力" },
] satisfies readonly { kind: SlideFrameLayout; name: string; title: string; lead: string }[];

const rules = new Set(["slide-section-rule", "slide-content-title-rule"]);

function rgbToHex(value: string) {
  const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(value)?.slice(1);
  return channels && "#" + channels.map((channel) => Number(channel).toString(16).padStart(2, "0")).join("");
}

function readLayout(section: HTMLElement, layout: (typeof layouts)[number]) {
  const canvas = section.getBoundingClientRect();
  const elements = Array.from(section.querySelectorAll<HTMLElement>("[data-slot]")).flatMap<RawElement>((node) => {
    const slot = node.dataset.slot;
    if (!slot || slot === "slide-content-main") return [];
    const isRule = rules.has(slot);
    const text = node.textContent?.trim();
    if (!isRule && (!text || node.children.length > 0)) return [];
    const bounds = node.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return [];
    const x = bounds.left - canvas.left;
    const y = bounds.top - canvas.top;
    const style = getComputedStyle(node);
    if (isRule) {
      const color = rgbToHex(style.backgroundColor);
      if (!color) return [];
      return [{
        type: "vector", shape: "polygon", closed: true, decorative: true,
        points: [
          { x, y }, { x: x + bounds.width, y },
          { x: x + bounds.width, y: y + bounds.height }, { x, y: y + bounds.height },
        ],
        fill: { color },
      }];
    }
    const size = Number.parseFloat(style.fontSize);
    const weight = Number(style.fontWeight);
    return [{
      type: "text",
      component_slot: slot,
      text,
      position: { x, y },
      size: {
        width: layout.kind === "content" || slot.endsWith("-title") ? canvas.width - x * 2 : bounds.width,
        height: Math.max(bounds.height, size * 1.25),
      },
      font: {
        family: style.fontFamily,
        size,
        color: rgbToHex(style.color),
        font_weight: weight,
        bold: weight >= 600,
        line_height: Number.parseFloat(style.lineHeight) / size || 1.2,
      },
    }];
  });
  return {
    id: `imagepit-${layout.kind}`,
    description: `IMAGEPIT ${layout.name}`,
    background: rgbToHex(getComputedStyle(section).backgroundColor),
    components: [],
    elements,
  };
}

export type ImagepitSlideLayout = ReturnType<typeof readLayout>;

export function ImagepitLayoutSource({ onReady }: { onReady: (layouts: ImagepitSlideLayout[]) => void }) {
  const source = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    let active = true;
    void document.fonts.ready.then(() => {
      if (!active || !source.current) return;
      const sections = Array.from(source.current.querySelectorAll("section"));
      onReady(layouts.flatMap((layout, index) => {
        const section = sections[index];
        return section ? [readLayout(section, layout)] : [];
      }));
    });
    return () => { active = false; };
  }, [onReady]);

  return (
    <div ref={source} aria-hidden="true" style={{ position: "fixed", left: -10000, top: 0, visibility: "hidden" }}>
      {layouts.map(({ kind, title, lead }) => (
        <section key={kind} className={`tm-layout ip-react-slide tm-layout-${kind}`} style={{ width: 1280, height: 720 }}>
          <SlideFrame layout={kind} breadcrumbs={[]} page={1} total={1}>
            {kind === "title-cover" ? <TitleCoverSlide title={title} lead={lead} /> :
              kind === "section-start" ? <SectionStartSlide title={title} lead={lead} /> :
                <ContentSlide title={title}><p data-slot="slide-content-text">{lead}</p></ContentSlide>}
          </SlideFrame>
        </section>
      ))}
    </div>
  );
}
