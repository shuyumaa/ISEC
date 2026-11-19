// @ts-check
import node from "@astrojs/node";
import { defineConfig } from "astro/config";

/**
 * Hosts the server may be reached on. Astro only trusts the Host / X-Forwarded-*
 * headers for these, and the CSRF origin check compares against them, so list
 * every public host (and the local dev host) here or in ISEC_HOSTS, e.g.
 *   ISEC_HOSTS="https://isec.gg,https://www.isec.gg"
 */
const hosts = (process.env.ISEC_HOSTS ?? "http://localhost:4321,http://127.0.0.1:4321")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean)
  .map((h) => {
    const u = new URL(h.includes("://") ? h : `http://${h}`);
    return { hostname: u.hostname, protocol: u.protocol.replace(":", ""), ...(u.port ? { port: u.port } : {}) };
  });

export default defineConfig({
  site: process.env.SITE_URL ?? "https://isec.example",
  output: "server",
  adapter: node({ mode: "standalone" }),
  trailingSlash: "ignore",
  security: {
    // CSRF origin checking is done in src/middleware.ts so the game-server
    // ingest endpoints (which never send an Origin header) can be exempted.
    checkOrigin: false,
    allowedDomains: hosts,
  },
  // No inlined scripts: the CSP allows only same-origin files plus the hashed theme script.
  vite: { build: { target: "es2022", assetsInlineLimit: 0 } },
});
