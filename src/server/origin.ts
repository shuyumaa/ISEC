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
