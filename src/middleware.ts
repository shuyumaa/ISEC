import { defineMiddleware } from "astro:middleware";
import { readSession } from "./server/auth";
import { CSP } from "./server/csp";
import { runAs } from "./server/actor";
import { csrfMatches, csrfToken, submittedToken } from "./server/csrf";
import { clientIp, servedOverHttps, trustedOrigin } from "./server/origin";
import { hit404, rateLimited } from "./server/ratelimit";
import { getSettings } from "./data";

const PUBLIC_ADMIN = new Set(["/admin/login", "/admin/login/", "/admin/logout", "/admin/logout/"]);
const withSlash = (p: string) => (p.endsWith("/") ? p : `${p}/`);

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const ALLOW_HEADER = "GET, HEAD, POST, OPTIONS";

/*
 * Pre-launch gate. While "coming soon" is on, visitors only see the holding
 * page at "/", and every other public page redirects there. The panels, the
 * sign-in page and the media/flag/asset routes those pages need stay open, and
 * signed-in admins browse the full site as a preview.
 */
const OPEN = /^\/(admin|team|login|logout|api|media|flags|_astro|coming-soon)(\/|$)/;
const isAsset = (p: string) => /\.[a-z0-9]+$/i.test(p);

/**
 * The path every access decision is made on: percent-decoded, duplicate
 * slashes and dot segments removed, lower case. So /%61dmin, //ADMIN and
 * /a/../admin are all treated exactly like /admin (the router decodes too).
 * Undefined when the path doesn't decode (malformed escapes).
 */
function decisionPath(raw: string): string | undefined {
  let p: string;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}${p.endsWith("/") && out.length ? "/" : ""}`.toLowerCase();
}

/** Security headers on every response, also errors and redirects made here. */
function secure(res: Response, ctx: { request: Request; url: URL }): Response {
  let r = res;
  try {
    r.headers.set("X-Content-Type-Options", "nosniff");
  } catch {
    // Immutable headers (e.g. Response.redirect): copy into a mutable response.
    r = new Response(res.body, res);
    r.headers.set("X-Content-Type-Options", "nosniff");
  }
  const h = r.headers;
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", CSP);
  if (!h.has("Cross-Origin-Resource-Policy")) h.set("Cross-Origin-Resource-Policy", "same-origin");
  if (servedOverHttps(ctx.request, ctx.url)) h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.delete("X-Powered-By");
  return r;
}

const plain = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { pathname } = ctx.url;
  const method = ctx.request.method;
  const done = (res: Response) => secure(res, ctx);

  // Only the methods the site uses; TRACE and friends get a clean 405.
  if (!ALLOWED.has(method)) return done(plain("Method not allowed", 405, { Allow: ALLOW_HEADER }));
  if (method === "OPTIONS") return done(new Response(null, { status: 204, headers: { Allow: ALLOW_HEADER } }));

  const path = decisionPath(pathname);
  if (path === undefined) return done(plain("Bad request", 400));

  // Rate limits per visitor (their own address, not the proxy's).
  const ip = clientIp(ctx.request, ctx.clientAddress);
  const limited = rateLimited(ip, path, method);
  if (limited) return done(plain("Too many requests. Slow down and try again shortly.", 429, { "Retry-After": String(limited) }));

  const https = servedOverHttps(ctx.request, ctx.url);
  ctx.locals.csrf = csrfToken(ctx.cookies, https);

  // State-changing requests: same origin, and the CSRF token from this
  // visitor's cookie. The game-server ingest endpoints authenticate with a
  // secret key in the URL instead.
  if (!SAFE.has(method) && !path.startsWith("/api/ingest/")) {
    if (!trustedOrigin(ctx.request.headers.get("origin"), ctx.url)) return done(plain("Cross-site requests are forbidden", 403));
    // Body size caps before anything parses the body: admin forms and the
    // assistant may carry images; everything else (sign-in) is tiny.
    const uploads = ((path.startsWith("/admin/") || path.startsWith("/team/")) && !PUBLIC_ADMIN.has(path)) || path === "/api/admin/assistant";
    const limit = uploads ? 26 * 1024 * 1024 : 64 * 1024;
    const length = ctx.request.headers.get("content-length");
    // A DELETE has no body (browsers send no Content-Length for it).
    if (length === null && method !== "DELETE") return done(plain("Length required", 411));
    if (Number(length) > limit) return done(plain("Payload too large", 413));
    if (!csrfMatches(ctx.locals.csrf, await submittedToken(ctx.request)))
      return done(plain("This form has expired. Reload the page and try again.", 403));
  }

  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  const isTeam = path === "/team" || path.startsWith("/team/");
  const isAdminApi = path.startsWith("/api/admin/");
  const user = readSession(ctx.cookies);
  ctx.locals.user = user ?? undefined;

  // Each panel needs its own role; anyone else goes to the shared sign-in page.
  const needs = isAdminApi || (isAdmin && !PUBLIC_ADMIN.has(path)) ? "admin" : isTeam ? "team" : undefined;
  if (needs && user?.role !== needs) {
    if (isAdminApi) return done(plain("Unauthorized", 401));
    if (user?.role && method !== "GET") return done(plain("Forbidden", 403));
    // Signed in to the other panel: send them home instead of to the login page.
    if (user) return done(ctx.redirect(user.role === "admin" ? "/admin/" : "/team/", 303));
    return done(ctx.redirect(`/login/?next=${encodeURIComponent(withSlash(path))}`, 303));
  }

  let rewrite: string | undefined;
  const gated = getSettings().comingSoon && user?.role !== "admin" && SAFE.has(method) && !OPEN.test(path) && !isAsset(path);
  if (gated) {
    if (path !== "/") return done(new Response(null, { status: 302, headers: { Location: "/", "Cache-Control": "no-store" } }));
    rewrite = "/coming-soon/";
  }

  const res = done(await runAs(user ? (user.role === "team" ? `team:${user.username}` : user.username) : "visitor", () => (rewrite ? next(rewrite) : next())));
  const h = res.headers;
  if (res.status === 404) hit404(ip);

  // Hover preloading for public pages (rules in src/pages/speculationrules.json.ts).
  if (!rewrite && !isAdmin && !isAdminApi && !isTeam && (h.get("Content-Type") ?? "").includes("text/html")) {
    h.set("Speculation-Rules", '"/speculationrules.json"');
  }
  if (isAdmin || isAdminApi || isTeam || path.startsWith("/login") || rewrite || path.startsWith("/coming-soon")) {
    h.set("Cache-Control", "no-store");
    h.set("X-Robots-Tag", "noindex, nofollow");
  } else if ((h.get("Content-Type") ?? "").includes("text/html") && !h.has("Cache-Control")) {
    // Live data: always revalidate HTML.
    h.set("Cache-Control", "no-cache");
  }
  return res;
});
