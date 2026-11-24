import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { APIRoute } from "astro";
import { isCountry } from "../../data/countries";
// Chinese Taipei competes under its Olympic flag, not the dataset's flag.
import chineseTaipei from "../../assets/flags/chinese-taipei.svg?raw";

const OVERRIDES: Record<string, string> = { tw: chineseTaipei };

/* Country flags (flag-icons, MIT), 4:3 SVG. Public and immutable, so cached for a year. */
const DIR = join(dirname(createRequire(import.meta.url).resolve("flag-icons/package.json")), "flags", "4x3");
const cache = new Map<string, Buffer>();

export const GET: APIRoute = async ({ params }) => {
  const m = /^([a-z]{2})\.svg$/.exec(params.code ?? "");
  if (!m || !isCountry(m[1])) return new Response("Not found", { status: 404 });
  let body = cache.get(m[1]!);
  if (!body && OVERRIDES[m[1]!]) body = Buffer.from(OVERRIDES[m[1]!]!);
  if (!body) {
    try {
      body = await readFile(join(DIR, `${m[1]}.svg`));
    } catch {
      return new Response("Not found", { status: 404 });
    }
    cache.set(m[1]!, body);
  }
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=31536000, immutable",
      // An SVG opened directly must not run anything.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
};
