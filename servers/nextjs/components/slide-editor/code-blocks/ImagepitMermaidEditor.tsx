"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { MERMAID_CSS_LIMIT, MERMAID_SOURCE_LIMIT, renderImagepitMermaid } from "@/lib/imagepit-mermaid";

export function ImagepitMermaidEditor({
  initial,
  initialCss,
  onSave,
  onClose,
}: {
  initial: string;
  initialCss: string;
  onSave: (source: string, css: string, data: string) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState(initial);
  const [css, setCss] = useState(initialCss);
  const [preview, setPreview] = useState<{ source: string; css: string; data: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source.trim()) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void renderImagepitMermaid(source, css).then((data) => {
        if (active) setPreview({ source, css, data });
      }).catch((error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : "Could not render the diagram.");
      });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [source, css]);

  const canSave = preview?.source === source && preview.css === css;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="z-[11000] max-h-[90vh] w-[min(94vw,1000px)] max-w-none overflow-auto" data-inline-edit-ignore="true">
        <DialogTitle>Edit Mermaid Diagram</DialogTitle>
        <DialogDescription>Edit the Mermaid source and style, then preview the diagram.</DialogDescription>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="grid gap-4">
            <label className="grid gap-2 text-sm font-medium">
              Mermaid source
              <textarea className="min-h-64 w-full rounded-md border p-3 font-mono"
                spellCheck={false} maxLength={MERMAID_SOURCE_LIMIT} value={source}
                onChange={(event) => {
                  setPreview(null);
                  setError(null);
                  setSource(event.target.value);
                }} />
            </label>
            <label className="grid gap-2 text-sm font-medium">
              Pele CSS variables
              <textarea className="min-h-32 w-full rounded-md border p-3 font-mono"
                spellCheck={false} maxLength={MERMAID_CSS_LIMIT} value={css}
                placeholder={'--pele-surface: #dbeafe;\n--pele-line: #2563eb;'}
                onChange={(event) => {
                  setPreview(null);
                  setError(null);
                  setCss(event.target.value);
                }} />
            </label>
          </div>
          <section aria-label="Diagram preview" className="grid min-h-64 place-items-center overflow-auto rounded-md border p-3">
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview.data} alt="Mermaid diagram preview" className="max-h-80 max-w-full" />
            )}
            {error && <p role="alert" className="whitespace-pre-wrap text-sm text-[#B42318]">{error}</p>}
          </section>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!canSave}
            className="rounded-md bg-[#6938EF] px-4 py-2 text-sm text-white disabled:opacity-50"
            onClick={() => { if (canSave) onSave(source, css, preview.data); }}>Save</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
