import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRoute } from "astro";
import { UPLOAD_DIR, UPLOAD_NAME } from "../../../server/uploads";

/* Uploaded images, protected like the logo: only served to our own pages as images. */
const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;

export const GET: APIRoute = async ({ params, request, url }) => {
  const file = params.file ?? "";
  if (!UPLOAD_NAME.test(file)) return new Response("Not found", { status: 404 });
  const dest = request.headers.get("sec-fetch-dest");
  const site = request.headers.get("sec-fetch-site");
  let sameOriginReferer = false;
  try {
    const ref = request.headers.get("referer");
    sameOriginReferer = !!ref && new URL(ref).origin === url.origin;
  } catch {
    /* malformed referer */
  }
  const allowed = dest ? dest === "image" && site === "same-origin" : sameOriginReferer;
  if (!allowed) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
  try {
    const body = await readFile(join(UPLOAD_DIR, file));
    return new Response(body, {
      headers: {
        "Content-Type": TYPES[file.split(".").pop() as keyof typeof TYPES],
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=604800, immutable",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Robots-Tag": "noindex, noimageindex",
        Vary: "Sec-Fetch-Dest, Sec-Fetch-Site, Referer",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
};
