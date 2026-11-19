import { defineMiddleware } from "astro:middleware";
import { readSession } from "./server/auth";

const PUBLIC_ADMIN = new Set(["/admin/login", "/admin/login/", "/admin/logout", "/admin/logout/"]);

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export const onRequest = defineMiddleware(async (ctx, next) => {
  const { pathname } = ctx.url;

  // CSRF: every state-changing request must come from our own origin, except
  // the game-server ingest endpoints, which authenticate with a secret key.
  if (!SAFE.has(ctx.request.method) && !pathname.startsWith("/api/ingest/")) {
    if (ctx.request.headers.get("origin") !== ctx.url.origin) {
      return new Response("Cross-site requests are forbidden", { status: 403 });
    }
  }
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  const isAdminApi = pathname.startsWith("/api/admin/");

  if ((isAdmin && !PUBLIC_ADMIN.has(pathname)) || isAdminApi) {
    const session = readSession(ctx.cookies, ctx.url);
    if (!session) {
      if (isAdminApi) return new Response("Unauthorized", { status: 401 });
      return ctx.redirect(`/admin/login?next=${encodeURIComponent(pathname)}`, 303);
    }
    ctx.locals.admin = session;
  }

  const res = await next();
  const h = res.headers;

  // Security headers for every response.
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (!h.has("Content-Security-Policy")) {
    h.set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  }
  if (!h.has("Cross-Origin-Resource-Policy")) h.set("Cross-Origin-Resource-Policy", "same-origin");
  if (ctx.url.protocol === "https:") {
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (isAdmin || isAdminApi) {
    h.set("Cache-Control", "no-store");
    h.set("X-Robots-Tag", "noindex, nofollow");
  } else if ((h.get("Content-Type") ?? "").includes("text/html") && !h.has("Cache-Control")) {
    // Live data: always revalidate HTML.
    h.set("Cache-Control", "no-cache");
  }
  return res;
});
