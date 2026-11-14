"use client";

import { CodeBlock } from "@imagepit/ui/code-block";
import { ExecPair, type ExecPairContent } from "@imagepit/ui/exec-pair";
import { annotationKindsForLine, parseAnnotations } from "@imagepit/md-react/annotations";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CODE_BLOCK_WIDTH,
  fitCodeBlockFrame,
  type ImagepitCodeBlockSource,
} from "@/lib/imagepit-code-block";

type CodeBlockPreview =
  | { kind: "code"; source: ImagepitCodeBlockSource; code: string; html: string }
  | { kind: "command"; source: ImagepitCodeBlockSource; input: ExecPairContent; output: ExecPairContent };

function commandContent(code: string, language: string, title?: string): ExecPairContent {
  const parsed = parseAnnotations(code, { callouts: true, turnCallouts: true });
  return {
    code: parsed.code,
    language,
    title,
    lines: parsed.code.split("\n").map((text, index) => {
      const line = index + 1;
      return {
        text,
        annotationKinds: annotationKindsForLine(parsed.annotations, line),
        callout: parsed.callouts.find((callout) => callout.line === line),
        turnCallouts: parsed.turnCallouts?.filter((callout) => callout.line === line),
      };
    }),
  };
}

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
  const [preview, setPreview] = useState<CodeBlockPreview | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      if (source.output) {
        setPreview({
          kind: "command",
          source,
          input: commandContent(source.code, source.language, source.filename || undefined),
          output: commandContent(source.output.code, source.output.language, source.output.title),
        });
        return;
      }
      void import("@imagepit/md-react/highlight")
        .then(({ highlightAnnotated }) =>
          highlightAnnotated(source.code, source.language, { callouts: true, turnCallouts: true }),
        )
        .then(({ code, html }) => {
          if (active) setPreview({ kind: "code", source, code, html });
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
      {preview.kind === "command" ? (
        <ExecPair
          input={preview.input}
          output={preview.output}
          capabilities={{ copyButton: false, outputToggle: false }}
        />
      ) : (
        <CodeBlock
          code={preview.code}
          html={preview.html}
          filename={preview.source.filename || undefined}
          language={preview.source.language}
          capabilities={{ copyButton: false }}
        />
      )}
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
