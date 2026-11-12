"use client";

import { CodeBlock } from "@imagepit/ui/code-block";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CODE_BLOCK_WIDTH,
  fitCodeBlockFrame,
  type ImagepitCodeBlockSource,
} from "@/lib/imagepit-code-block";

export function ImagepitCodeBlockView({
  source,
  onReady,
  onError,
  frame,
}: {
  source: ImagepitCodeBlockSource;
  onReady: (node: HTMLElement) => void;
  onError: (message: string) => void;
  frame?: { width: number; height: number };
}) {
  const node = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{
    source: ImagepitCodeBlockSource;
    code: string;
    html: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void import("@imagepit/md-react/highlight")
        .then(({ highlightAnnotated }) =>
          highlightAnnotated(source.code, source.language, { callouts: true, turnCallouts: true }),
        )
        .then(({ code, html }) => {
          if (active) setPreview({ source, code, html });
        })
        .catch(() => {
          if (active) onError("Could not render the code preview.");
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [source, onError]);

  useLayoutEffect(() => {
    const root = node.current;
    if (preview?.source !== source || !root) return;
    fitCodeBlockFrame(root, frame);
    onReady(root);
  }, [preview, source, onReady, frame]);

  if (!preview) return null;

  const isSlide = preview.source.style === "slide";
  const block = (
    <div
      ref={node}
      className={isSlide ? "imagepit-slide-code-block" : undefined}
      style={{ width: CODE_BLOCK_WIDTH, display: "flow-root" }}
    >
      <CodeBlock
        code={preview.code}
        html={preview.html}
        filename={preview.source.filename || undefined}
        language={preview.source.language}
        capabilities={{ copyButton: false }}
      />
    </div>
  );

  // Resolve the slide stylesheet's container units against a 1280px slide
  // so changing the block width leaves typography and padding intact.
  return isSlide ? (
    <section className="tm-layout ip-react-slide" style={{ width: 1280, padding: 0, overflow: "visible" }}>
      {block}
    </section>
  ) : block;
}
