/*
 * Per-visitor request limits (in memory, per address; the address comes from
 * clientIp(), so visitors behind the same proxy aren't lumped together).
 * Generous for people, tight for scripts:
 *  - pages and API reads: 240 a minute;
 *  - writes (POST/PUT/PATCH/DELETE): 60 a minute;
 *  - static assets, images and the live update stream don't count;
 *  - an address that gets more than 150 "not found" answers in 10 minutes
 *    (guessing URLs) is refused for 10 minutes.
 * Sign-in has its own, stricter rules (server/auth.ts).
 */

interface Window {
  start: number;
  n: number;
}
const MINUTE = 60_000;
const reads = new Map<string, Window>();
const writes = new Map<string, Window>();
const misses = new Map<string, Window>();
const blocked = new Map<string, number>();

const FREE = /^\/(_astro|flags|media)\/|^\/(favicon\.png|apple-touch-icon\.png|speculationrules\.json)$|^\/api\/live\/?$/;

function count(m: Map<string, Window>, ip: string, span: number) {
  const now = Date.now();
  if (m.size > 50_000) for (const [k, w] of m) if (now - w.start > span) m.delete(k);
  const w = m.get(ip);
  if (!w || now - w.start > span) {
    m.set(ip, { start: now, n: 1 });
    return { n: 1, reset: now + span };
  }
  w.n += 1;
  return { n: w.n, reset: w.start + span };
}

// For load tests on a private server only; never set this in production.
const OFF = process.env.ISEC_RATE_LIMIT === "off";

/** Seconds to wait when the request is over a limit, otherwise 0. */
export function rateLimited(ip: string, path: string, method: string): number {
  if (OFF) return 0;
  const now = Date.now();
  const until = blocked.get(ip);
  if (until && until > now) return Math.ceil((until - now) / 1000);
  if (until) blocked.delete(ip);
  if (FREE.test(path)) return 0;
  const write = !(method === "GET" || method === "HEAD");
  const { n, reset } = count(write ? writes : reads, ip, MINUTE);
  return n > (write ? 60 : 240) ? Math.ceil((reset - now) / 1000) : 0;
}

/** Called for every 404 the site answers. */
export function hit404(ip: string) {
  if (OFF) return;
  const { n } = count(misses, ip, 10 * MINUTE);
  if (n > 150) {
    blocked.set(ip, Date.now() + 10 * MINUTE);
    misses.delete(ip);
  }
}
