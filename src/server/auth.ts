import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { AstroCookies } from "astro";

/*
 * Single-role admin auth.
 *  - ADMIN_PASSWORD (required in production) is compared with scrypt + timingSafeEqual.
 *  - Sessions are stateless HMAC-signed cookies (SESSION_SECRET), HttpOnly,
 *    SameSite=Lax, Secure + __Host- prefix whenever the site is served over HTTPS.
 */


function resolvePassword(): string {
  if (process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 12) console.warn("[isec] ADMIN_PASSWORD is shorter than 12 characters.");
    return process.env.ADMIN_PASSWORD;
  }
  // The fallback exists only for `astro dev`; a built server never starts without a password.
  if (!import.meta.env.DEV) throw new Error("ADMIN_PASSWORD must be set.");
  const dev = "isec-admin";
  console.warn(`[isec] ADMIN_PASSWORD not set — using the development password "${dev}".`);
  return dev;
}

const salt = randomBytes(16);
const passwordHash = scryptSync(resolvePassword(), salt, 32);
// Bound to the password, so changing ADMIN_PASSWORD signs every session out.
const secret = `${process.env.SESSION_SECRET ?? randomBytes(32).toString("hex")}:${passwordHash.toString("hex")}`;
if (!process.env.SESSION_SECRET && !import.meta.env.DEV) {
  console.warn("[isec] SESSION_SECRET not set — admin sessions will reset on every restart.");
}

const SESSION_HOURS = 12;

export function checkPassword(input: string): boolean {
  const hash = scryptSync(input, salt, 32);
  return timingSafeEqual(hash, passwordHash);
}

const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function cookieName(url: URL) {
  return url.protocol === "https:" ? "__Host-isec_session" : "isec_session";
}

export function createSession(cookies: AstroCookies, url: URL) {
  const payload = Buffer.from(JSON.stringify({ sub: "admin", exp: Date.now() + SESSION_HOURS * 3600_000 })).toString("base64url");
  cookies.set(cookieName(url), `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export function destroySession(cookies: AstroCookies, url: URL) {
  cookies.delete(cookieName(url), { path: "/" });
}

export function readSession(cookies: AstroCookies, url: URL): { sub: string } | null {
  const raw = cookies.get(cookieName(url))?.value;
  if (!raw) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub: string; exp: number };
    return data.exp > Date.now() ? { sub: data.sub } : null;
  } catch {
    return null;
  }
}

/* Naive in-memory login throttle: 5 failures per IP per 10 minutes. */
const attempts = new Map<string, { n: number; until: number }>();
export function throttled(ip: string): boolean {
  const a = attempts.get(ip);
  return !!a && a.n >= 5 && a.until > Date.now();
}
export function recordFailure(ip: string) {
  // Prune expired entries so the map can't grow without bound.
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
  const a = attempts.get(ip);
  const fresh = !a || a.until < Date.now();
  attempts.set(ip, { n: fresh ? 1 : a.n + 1, until: Date.now() + 10 * 60_000 });
}
export function clearFailures(ip: string) {
  attempts.delete(ip);
}
