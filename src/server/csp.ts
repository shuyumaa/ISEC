import { createHash } from "node:crypto";

/**
 * The only inline script on any page: applies a stored colour-scheme override
 * before first paint (FOUC guard). Kept here so the CSP hash always matches.
 */
export const THEME_SCRIPT =
  'try{document.querySelector(\'meta[name="color-scheme"]\').content=localStorage.getItem("color-scheme")??"light dark"}catch{}';

const hash = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

export const CSP = [
  "default-src 'self'",
  // `astro dev` injects inline module scripts (HMR, toolbar); built servers allow only the theme hash.
  import.meta.env.DEV ? "script-src 'self' 'unsafe-inline'" : `script-src 'self' ${hash(THEME_SCRIPT)} 'report-sample'`,
  // Inline style attributes carry data-driven custom properties (bar widths, image URLs).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  import.meta.env.DEV ? "connect-src 'self' ws:" : "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // DOM XSS sinks only accept values from the one named policy (src/scripts/live.ts).
  "require-trusted-types-for 'script'",
  "trusted-types isec-live",
].join("; ");
