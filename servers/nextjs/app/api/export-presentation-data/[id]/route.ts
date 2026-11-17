import { NextRequest, NextResponse } from "next/server";

const OUTLINE_ASSET_PATH =
  /^\/api\/v1\/ppt\/outline-import\/[0-9a-f-]{36}\/image$/;
const OUTLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function getFastApiBaseUrl(): string {
  const internal = process.env.FAST_API_INTERNAL_URL?.trim();
  if (internal) {
    return internal.replace(/\/+$/, "");
  }

  const configured = process.env.NEXT_PUBLIC_FAST_API?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return "http://127.0.0.1:8000";
}

async function embedOutlineImages(
  value: unknown,
  resolveImage: (assetPath: string) => Promise<string>,
): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => embedOutlineImages(item, resolveImage)));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (
    "type" in value &&
    value.type === "image" &&
    "data" in value &&
    typeof value.data === "string" &&
    OUTLINE_ASSET_PATH.test(value.data)
  ) {
    return { ...value, data: await resolveImage(value.data) };
  }

  return Object.fromEntries(
    await Promise.all(
      Object.entries(value).map(async ([key, child]) => [
        key,
        await embedOutlineImages(child, resolveImage),
      ]),
    ),
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json(
      { detail: "Missing presentation id" },
      { status: 400 }
    );
  }

  const exportCookie = request.headers.get("x-export-cookie")?.trim();
  if (!exportCookie) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }

  const backend = getFastApiBaseUrl();
  const presentationUrl = `${backend}/api/v1/ppt/presentation/${encodeURIComponent(id)}`;

  try {
    const response = await fetch(presentationUrl, {
      headers: { Cookie: exportCookie },
      cache: "no-store",
    });
    const headers = {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    };
    if (!response.ok) {
      return new NextResponse(await response.text(), { status: response.status, headers });
    }

    const presentation: unknown = await response.json();
    const assets = new Map<string, Promise<string>>();
    const resolveImage = (assetPath: string) => {
      const existing = assets.get(assetPath);
      if (existing) return existing;
      const download = (async () => {
        const image = await fetch(`${backend}${assetPath}`, {
          headers: { Cookie: exportCookie },
          cache: "no-store",
          redirect: "error",
        });
        const type = image.headers.get("content-type");
        if (!image.ok || !type || !OUTLINE_IMAGE_TYPES.has(type)) {
          throw new Error("Outline image is unavailable for export");
        }
        return `data:${type};base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`;
      })();
      assets.set(assetPath, download);
      return download;
    };
    const data = await embedOutlineImages(presentation, resolveImage);
    return NextResponse.json(data, { headers });
  } catch (error) {
    console.error("[export-presentation-data] Failed to prepare presentation", error);
    return NextResponse.json(
      { detail: "Failed to prepare presentation data for export" },
      { status: 502 }
    );
  }
}
