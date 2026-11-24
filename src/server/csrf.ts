import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AstroCookies } from "astro";

/*
 * CSRF tokens (double submit), a second layer behind the Origin check in the
 * middleware: a random token lives in an HttpOnly, SameSite=Strict cookie and
 * the server writes the same value into every POST form (`_csrf`) and a
 * <meta name="csrf-token"> for scripts (sent as X-CSRF-Token). A request from
 * another site can't read either, so it can't send a matching pair.
 */

const SECURE = "__Host-isec_csrf";
const PLAIN = "isec_csrf";
export const CSRF_FIELD = "_csrf";
export const CSRF_HEADER = "x-csrf-token";

/** The visitor's token, creating (and setting) one on first contact. */
export function csrfToken(cookies: AstroCookies, secure: boolean): string {
  const have = cookies.get(SECURE)?.value ?? cookies.get(PLAIN)?.value;
  if (have && /^[A-Za-z0-9_-]{43}$/.test(have)) return have;
  const t = randomBytes(32).toString("base64url");
  cookies.set(secure ? SECURE : PLAIN, t, { httpOnly: true, sameSite: "strict", secure, path: "/", maxAge: 60 * 60 * 24 * 30 });
  return t;
}

export function csrfMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token a state-changing request carries: header first, else the form field. */
export async function submittedToken(request: Request): Promise<string | null> {
  const h = request.headers.get(CSRF_HEADER);
  if (h) return h;
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded") && !type.startsWith("multipart/form-data")) return null;
  try {
    // A clone, so the page can still read the body.
    const v = (await request.clone().formData()).get(CSRF_FIELD);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
