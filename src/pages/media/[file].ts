import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { APIRoute } from "astro";
import { trustedOrigin } from "../../server/origin";

/*
 * Protected brand media. The logo files live outside /public and are only
 * served when the browser is loading them *as an image for one of our own
 * pages* (Sec-Fetch-Dest: image, same-origin). Opening the URL directly in a
 * tab, hot-linking from another site or fetching it with a script is refused.
 */

const DIR = resolve(process.env.BRAND_DIR ?? "./private/brand");
const ALLOWED = /^isec-logo-(light|dark)(-(480|960))?\.(png|webp)$/;
const TYPES = { png: "image/png", webp: "image/webp" } as const;

export const GET: APIRoute = async ({ params, request, url }) => {
  const file = params.file ?? "";
  if (!ALLOWED.test(file)) return new Response("Not found", { status: 404 });

  const dest = request.headers.get("sec-fetch-dest");
  const site = request.headers.get("sec-fetch-site");
  const referer = request.headers.get("referer");
  let sameOriginReferer = false;
  try {
    sameOriginReferer = !!referer && trustedOrigin(new URL(referer).origin, url);
  } catch {
    /* malformed referer */
  }

  // Modern browsers send Fetch Metadata; older ones fall back to the Referer check.
  const allowed = dest ? dest === "image" && site === "same-origin" : sameOriginReferer;
  if (!allowed) return new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });

  try {
    const body = await readFile(resolve(DIR, file));
    const ext = file.split(".").pop() as keyof typeof TYPES;
    return new Response(body, {
      headers: {
        "Content-Type": TYPES[ext],
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=86400",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Robots-Tag": "noindex, noimageindex",
        Vary: "Sec-Fetch-Dest, Sec-Fetch-Site, Referer",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
};
