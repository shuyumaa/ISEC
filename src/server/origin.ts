/*
 * Public origins, read when the server starts (not baked in at build time).
 *
 * Behind a reverse proxy (Caddy, nginx) the app sees an internal URL such as
 * http://isec:4321, while the browser is on https://isec.net.cn. Astro only
 * rewrites ctx.url when the host was listed at BUILD time, which made sign-in
 * fail with 403 whenever ISEC_HOSTS was set only at run time. These helpers
 * use the run-time ISEC_HOSTS list directly, so either way works.
 */
const origins = new Set(
  (process.env.ISEC_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .flatMap((h) => {
      try {
        return [new URL(h.includes("://") ? h : `https://${h}`).origin];
      } catch {
        return [];
      }
    }),
);

/** A state-changing request is same-site when its Origin is this server or a listed public origin. */
export function trustedOrigin(origin: string | null, url: URL): boolean {
  return !!origin && (origin === url.origin || origins.has(origin));
}

/** Whether the visitor reached us over HTTPS (directly, or through a listed proxy host). */
export function servedOverHttps(request: Request, url: URL): boolean {
  if (url.protocol === "https:") return true;
  const origin = request.headers.get("origin");
  if (origin && origins.has(origin)) return origin.startsWith("https:");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  for (const o of origins) if (new URL(o).host === host) return o.startsWith("https:");
  return false;
}

/*
 * The visitor's IP address. Behind the reverse proxy the socket peer is the
 * proxy itself (every visitor would share one address, so one person could
 * lock everybody out of sign-in), so the proxy's X-Forwarded-For is used when
 * the peer is a proxy we trust: loopback or a private network address (the
 * Docker network), or an address listed in TRUSTED_PROXIES. Only the
 * right-most X-Forwarded-For entry is used: that is the one the proxy added,
 * the ones before it come from the client and can be forged.
 */
const extraProxies = new Set((process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const privateAddr = (ip: string) =>
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80:)/i.test(ip.replace(/^::ffff:/i, ""));

export function clientIp(request: Request, peer: string | undefined): string {
  const p = (peer ?? "").replace(/^::ffff:/i, "");
  if (p && (privateAddr(p) || extraProxies.has(p))) {
    const xff = request.headers.get("x-forwarded-for");
    const last = xff?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last && /^[0-9a-f:.]{2,45}$/i.test(last)) return last.replace(/^::ffff:/i, "");
  }
  return p || "unknown";
}
