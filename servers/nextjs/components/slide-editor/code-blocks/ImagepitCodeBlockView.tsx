"use client";

import { CodeBlock } from "@imagepit/ui/code-block";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CODE_BLOCK_WIDTH,
  type ImagepitCodeBlockSource,
} from "@/lib/imagepit-code-block";

export function ImagepitCodeBlockView({
  source,
  onReady,
  onError,
}: {
  source: ImagepitCodeBlockSource;
  onReady: (node: HTMLElement) => void;
  onError: (message: string) => void;
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
    root.style.width = `${CODE_BLOCK_WIDTH}px`;
    const body = root.querySelector(".ui-code-block__pre");
    if (body) {
      const overflow = body.scrollWidth - body.clientWidth;
      if (overflow > 0) root.style.width = `${CODE_BLOCK_WIDTH + overflow}px`;
    }
    onReady(root);
  }, [preview, source, onReady]);

  if (!preview) return null;

  return (
    <div ref={node} style={{ width: CODE_BLOCK_WIDTH, display: "flow-root" }}>
      <CodeBlock
        code={preview.code}
        html={preview.html}
        filename={preview.source.filename || undefined}
        language={preview.source.language}
        capabilities={{ copyButton: false }}
      />
    </div>
  );
}
