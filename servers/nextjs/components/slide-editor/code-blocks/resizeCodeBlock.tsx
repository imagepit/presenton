import { createRoot } from "react-dom/client";
import { captureImagepitCodeBlock, IMAGEPIT_BLOCK_FRAME, type ImagepitCodeBlockSource } from "@/lib/imagepit-code-block";
import { ImagepitCodeBlockView } from "./ImagepitCodeBlockView";

export async function renderResizedCodeBlock(
  source: ImagepitCodeBlockSource,
  frame: { width: number; height: number },
) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.tabIndex = -1;
  iframe.style.cssText = "position:fixed;left:-10000px;width:640px;height:720px;visibility:hidden;border:0";
  iframe.srcdoc = IMAGEPIT_BLOCK_FRAME;
  const ready = new Promise<void>((resolve) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
  });
  document.body.append(iframe);
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    await ready;
    const body = iframe.contentDocument?.body;
    if (!body) throw new Error("Could not load the code block renderer.");
    root = createRoot(body);
    const previewRoot = root;
    const node = await new Promise<HTMLElement>((resolve, reject) => {
      previewRoot.render(
        <ImagepitCodeBlockView source={source} frame={frame} onReady={resolve}
          onError={(message) => reject(new Error(message))} />,
      );
    });
    return await captureImagepitCodeBlock(node, source, frame);
  } finally {
    root?.unmount();
    iframe.remove();
  }
}
