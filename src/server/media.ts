import { createHmac, timingSafeEqual } from "node:crypto";
import { mediaSecret } from "./secret";

/*
 * Uploaded images are served through signed, expiring URLs at the size they
 * are shown at. A URL copied out of the browser's developer tools stops
 * working after a few hours, can't be resized to get the original, and the
 * full-resolution upload never leaves the server.
 *
 * Note: anything a browser displays has been downloaded, so it can always be
 * seen in developer tools. This limits what such a copy is worth.
 */

/** Widths we render (2x of the largest CSS size each slot uses). */
export const MEDIA_WIDTHS = [160, 320, 640, 960] as const;
export type MediaWidth = (typeof MEDIA_WIDTHS)[number];

const HOUR = 3600;
// URLs change once an hour (so they cache) and stay valid for 6 more hours.
const LIFETIME = 6 * HOUR;

const sign = (file: string, w: number, exp: number) =>
  createHmac("sha256", mediaSecret()).update(`${file}|${w}|${exp}`).digest("base64url").slice(0, 22);

export function mediaUrl(file: string, w: MediaWidth = 640) {
  const exp = Math.ceil(Date.now() / 1000 / HOUR) * HOUR + LIFETIME;
  return `/media/u/${file}?w=${w}&e=${exp}&s=${sign(file, w, exp)}`;
}

/** The checked width, or undefined when the signature is wrong or expired. */
export function verifyMedia(file: string, url: URL): { w: MediaWidth; exp: number } | undefined {
  const w = Number(url.searchParams.get("w"));
  const exp = Number(url.searchParams.get("e"));
  const s = url.searchParams.get("s") ?? "";
  if (!MEDIA_WIDTHS.includes(w as MediaWidth) || !Number.isInteger(exp) || exp * 1000 < Date.now()) return undefined;
  const good = Buffer.from(sign(file, w, exp));
  const got = Buffer.from(s);
  return got.length === good.length && timingSafeEqual(got, good) ? { w: w as MediaWidth, exp } : undefined;
}
