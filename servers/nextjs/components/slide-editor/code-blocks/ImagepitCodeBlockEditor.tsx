"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ImagepitCodeBlockView } from "./ImagepitCodeBlockView";
import {
  captureImagepitCodeBlock,
  CODE_BLOCK_MAX_LENGTH,
  codeBlockContentScale,
  IMAGEPIT_BLOCK_FRAME,
  resolveCodeBlockRasterSize,
  type ImagepitCodeBlockSource,
} from "@/lib/imagepit-code-block";

type RenderedBlock = Awaited<ReturnType<typeof captureImagepitCodeBlock>>;

export function ImagepitCodeBlockEditor({
  initial,
  onSave,
  onClose,
  frame,
  element,
}: {
  initial: ImagepitCodeBlockSource;
  frame: { width: number; height: number };
  element: Record<string, unknown>;
  onSave: (block: RenderedBlock) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState(initial);
  const [doc, setDoc] = useState<Document | null>(null);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [scale, setScale] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void resolveCodeBlockRasterSize(element).then((raster) => {
      if (active) setScale(codeBlockContentScale({ width: frame.width, height: frame.height }, raster));
    });
    return () => { active = false; };
  }, [element, frame.width, frame.height]);
  const rasterFrame = scale === null ? undefined : {
    width: frame.width / scale,
    height: frame.height / scale,
  };

  function update<Field extends keyof ImagepitCodeBlockSource>(
    field: Field,
    value: ImagepitCodeBlockSource[Field],
  ) {
    setNode(null);
    setError(null);
    setSource((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    if (!node || saving || !rasterFrame || scale === null) return;
    setSaving(true);
    setError(null);
    try {
      const block = await captureImagepitCodeBlock(node, source, rasterFrame);
      onSave({
        ...block,
        size: { width: block.size.width * scale, height: block.size.height * scale },
      });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save the code block.");
    } finally {
      setSaving(false);
    }
  }

  const inputClass = "w-full rounded-md border border-[#D4D4D8] bg-white px-3 py-2 text-sm";

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="z-[11000] max-h-[90vh] w-[min(94vw,1200px)] max-w-none overflow-auto" data-inline-edit-ignore="true">
        <DialogTitle>Edit Code Block</DialogTitle>
        <DialogDescription>Edit the source and preview its line highlights and callouts.</DialogDescription>
        <div className="grid gap-5 lg:grid-cols-[1fr_580px]">
          <fieldset disabled={saving} className="grid min-w-0 gap-3">
            <label className="grid gap-1 text-sm font-medium">
              Style
              <select className={inputClass} value={source.style}
                onChange={(event) => update("style", event.target.value === "slide" ? "slide" : "web")}>
                <option value="web">Web</option>
                <option value="slide">Slide</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm font-medium">
              File name
              <input className={inputClass} maxLength={160} value={source.filename} onChange={(event) => update("filename", event.target.value)} />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Language
              <input className={inputClass} maxLength={40} value={source.language} onChange={(event) => update("language", event.target.value)} />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Code source
              <textarea className={`${inputClass} min-h-64 font-mono`} spellCheck={false} maxLength={CODE_BLOCK_MAX_LENGTH}
                value={source.code} onChange={(event) => update("code", event.target.value)} />
            </label>
          </fieldset>
          <section aria-label="Code preview" aria-busy={!node && !error}>
            <h3 className="mb-2 text-sm font-medium">Preview</h3>
            <iframe title="Code Block preview" sandbox="allow-same-origin" className="h-80 w-full rounded-md border border-[#D4D4D8]"
              srcDoc={IMAGEPIT_BLOCK_FRAME} onLoad={(event) => setDoc(event.currentTarget.contentDocument)} />
            {doc?.body && rasterFrame && createPortal(<ImagepitCodeBlockView frame={rasterFrame} source={source} onReady={setNode} onError={setError} />, doc.body)}
          </section>
        </div>
        {error && <p role="alert" className="text-sm text-[#B42318]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={saving} className="rounded-md border px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={saving || !node || !source.code.trim()}
            className="rounded-md bg-[#6938EF] px-4 py-2 text-sm text-white disabled:opacity-50"
            onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
