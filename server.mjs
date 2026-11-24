// Production entry: the Astro server behind one guard that must run before
// Astro. Node's fetch Request refuses methods like TRACE and CONNECT, so the
// adapter would crash on them with a 500; they get a clean 405 here instead,
// with the same security headers every other response carries.
import http from "node:http";

process.env.ASTRO_NODE_AUTOSTART = "disabled";
const { handler } = await import("./dist/server/entry.mjs");

const ALLOWED = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  Allow: "GET, HEAD, POST, OPTIONS",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const server = http.createServer((req, res) => {
  if (!ALLOWED.has(req.method ?? "")) {
    res.writeHead(405, HEADERS);
    res.end("Method not allowed");
    return;
  }
  handler(req, res);
});
const port = Number(process.env.PORT ?? 4321);
const host = process.env.HOST ?? "0.0.0.0";
server.listen(port, host, () => console.log(`[isec] listening on http://${host}:${port}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
