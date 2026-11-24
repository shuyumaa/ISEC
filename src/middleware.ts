import { defineMiddleware } from "astro:middleware";
import { readSession } from "./server/auth";
import { CSP } from "./server/csp";
import { runAs } from "./server/actor";
import { servedOverHttps, trustedOrigin } from "./server/origin";
import { getSettings } from "./data";

const PUBLIC_ADMIN = new Set(["/admin/login", "/admin/login/", "/admin/logout", "/admin/logout/"]);
const withSlash = (p: string) => (p.endsWith("/") ? p : `${p}/`);

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/*
 * Pre-launch gate. While "coming soon" is on, visitors only see the holding
 * page at "/", and every other public page redirects there. The panels, the
 * sign-in page and the media/flag/asset routes those pages need stay open, and
 * signed-in admins browse the full site as a preview.
 */
const OPEN = /^\/(admin|team|login|logout|api|media|flags|_astro|coming-soon)(\/|$)/;
const isAsset = (p: string) => /\.[a-z0-9]+$/i.test(p);

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { pathname } = ctx.url;

  // CSRF: every state-changing request must come from our own origin, except
  // the game-server ingest endpoints, which authenticate with a secret key.
  if (!SAFE.has(ctx.request.method) && !pathname.startsWith("/api/ingest/")) {
    if (!trustedOrigin(ctx.request.headers.get("origin"), ctx.url)) {
      return new Response("Cross-site requests are forbidden", { status: 403 });
    }
    // Body size caps before anything parses the body: admin forms may carry
    // image uploads; everything else (sign-in) is tiny.
    // The assistant's chat can carry scoreboard screenshots too.
    const uploads = ((pathname.startsWith("/admin/") || pathname.startsWith("/team/")) && !PUBLIC_ADMIN.has(pathname)) || pathname === "/api/admin/assistant";
    const limit = uploads ? 26 * 1024 * 1024 : 64 * 1024;
    const length = ctx.request.headers.get("content-length");
    // A DELETE has no body (browsers send no Content-Length for it).
    if (length === null && ctx.request.method !== "DELETE") return new Response("Length required", { status: 411 });
    if (Number(length) > limit) return new Response("Payload too large", { status: 413 });
  }
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  const isTeam = pathname === "/team" || pathname.startsWith("/team/");
  const isAdminApi = pathname.startsWith("/api/admin/");
  const user = readSession(ctx.cookies);
  ctx.locals.user = user ?? undefined;

  // Each panel needs its own role; anyone else goes to the shared sign-in page.
  const needs = isAdminApi || (isAdmin && !PUBLIC_ADMIN.has(pathname)) ? "admin" : isTeam ? "team" : undefined;
  if (needs && user?.role !== needs) {
    if (isAdminApi) return new Response("Unauthorized", { status: 401 });
    if (user?.role && ctx.request.method !== "GET") return new Response("Forbidden", { status: 403 });
    // Signed in to the other panel: send them home instead of to the login page.
    if (user) return ctx.redirect(user.role === "admin" ? "/admin/" : "/team/", 303);
    return ctx.redirect(`/login/?next=${encodeURIComponent(withSlash(pathname))}`, 303);
  }

  let rewrite: string | undefined;
  const gated = getSettings().comingSoon && user?.role !== "admin" && SAFE.has(ctx.request.method) && !OPEN.test(pathname) && !isAsset(pathname);
  if (gated) {
    if (pathname !== "/") return new Response(null, { status: 302, headers: { Location: "/", "Cache-Control": "no-store" } });
    rewrite = "/coming-soon/";
  }

  const res = await runAs(user ? (user.role === "team" ? `team:${user.username}` : user.username) : "visitor", () => (rewrite ? next(rewrite) : next()));
  const h = res.headers;

  // Security headers for every response.
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", CSP);
  if (!h.has("Cross-Origin-Resource-Policy")) h.set("Cross-Origin-Resource-Policy", "same-origin");
  if (servedOverHttps(ctx.request, ctx.url)) {
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  // Hover preloading for public pages (rules in src/pages/speculationrules.json.ts).
  if (!rewrite && !isAdmin && !isAdminApi && !isTeam && (h.get("Content-Type") ?? "").includes("text/html")) {
    h.set("Speculation-Rules", '"/speculationrules.json"');
  }
  if (isAdmin || isAdminApi || isTeam || pathname.startsWith("/login") || rewrite || pathname.startsWith("/coming-soon")) {
    h.set("Cache-Control", "no-store");
    h.set("X-Robots-Tag", "noindex, nofollow");
  } else if ((h.get("Content-Type") ?? "").includes("text/html") && !h.has("Cache-Control")) {
    // Live data: always revalidate HTML.
    h.set("Cache-Control", "no-cache");
  }
  return res;
});
