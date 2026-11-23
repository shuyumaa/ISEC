import type { APIRoute } from "astro";

/*
 * Speculation rules (Modern Web Guidance: improve-next-page-load-performance),
 * announced with the Speculation-Rules response header so the strict CSP
 * needs no inline script.
 *  - Prerender on hover ("moderate") for the important links: the top bar,
 *    rail buttons, match rows, and links marked data-prerender.
 *  - Prefetch on hover for every other same-site page link.
 *  - Never: admin, API, media, flags, sign-out, or anything with ?query.
 */
const exclude = [
  { not: { href_matches: "/admin/*" } },
  { not: { href_matches: "/admin" } },
  { not: { href_matches: "/api/*" } },
  { not: { href_matches: "/media/*" } },
  { not: { href_matches: "/flags/*" } },
  { not: { href_matches: "/*\\?*" } },
  { not: { selector_matches: "[rel~=nofollow], [target=_blank], [download]" } },
];

const rules = {
  prerender: [
    {
      tag: "isec-important",
      where: {
        and: [{ href_matches: "/*" }, { selector_matches: ".site-header a, .rail-button, .match-row, a[data-prerender]" }, ...exclude],
      },
      eagerness: "moderate",
    },
  ],
  prefetch: [
    {
      tag: "isec-links",
      where: { and: [{ href_matches: "/*" }, ...exclude] },
      eagerness: "moderate",
    },
  ],
};

export const GET: APIRoute = () =>
  new Response(JSON.stringify(rules), {
    headers: { "Content-Type": "application/speculationrules+json", "Cache-Control": "public, max-age=3600" },
  });
