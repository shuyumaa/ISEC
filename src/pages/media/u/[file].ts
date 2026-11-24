import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { APIRoute } from "astro";
import sharp from "sharp";
import { verifyMedia } from "../../../server/media";
import { trustedOrigin } from "../../../server/origin";
import { UPLOAD_DIR, UPLOAD_NAME } from "../../../server/uploads";

/*
 * Uploaded images, protected three ways:
 *  - only served to our own pages as images (Fetch Metadata / Referer), so
 *    opening the URL in a tab or hot-linking it fails;
 *  - the URL is signed and expires (server/media.ts), so a copied link dies;
 *  - only resized copies leave the server, never the original upload.
 */

const CACHE = join(UPLOAD_DIR, ".sized");
const forbidden = () => new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });

export const GET: APIRoute = async ({ params, request, url }) => {
  const file = params.file ?? "";
  if (!UPLOAD_NAME.test(file)) return new Response("Not found", { status: 404 });

  const dest = request.headers.get("sec-fetch-dest");
  const site = request.headers.get("sec-fetch-site");
  let sameOriginReferer = false;
  try {
    const ref = request.headers.get("referer");
    sameOriginReferer = !!ref && trustedOrigin(new URL(ref).origin, url);
  } catch {
    /* malformed referer */
  }
  if (!(dest ? dest === "image" && site === "same-origin" : sameOriginReferer)) return forbidden();
  const ok = verifyMedia(file, url);
  if (!ok) return forbidden();

  const sized = join(CACHE, `${file}.${ok.w}.webp`);
  let body: Buffer;
  try {
    body = await readFile(sized);
  } catch {
    try {
      const original = await readFile(join(UPLOAD_DIR, file));
      // Never upscale; WebP keeps transparency for cut-out photos and logos.
      body = await sharp(original).rotate().resize({ width: ok.w, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
      await mkdir(CACHE, { recursive: true, mode: 0o700 });
      const tmp = `${sized}.${process.pid}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, sized);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
  const maxAge = Math.max(0, ok.exp - Math.floor(Date.now() / 1000));
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/webp",
      "Content-Disposition": "inline",
      "Cache-Control": `private, max-age=${maxAge}, immutable`,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Robots-Tag": "noindex, noimageindex",
      Vary: "Sec-Fetch-Dest, Sec-Fetch-Site, Referer",
    },
  });
};
