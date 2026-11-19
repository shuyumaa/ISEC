// @ts-check
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://isec.example",
  trailingSlash: "ignore",
  build: { format: "directory" },
  // Modern targets: polyfills are loaded conditionally at runtime, never bundled up-front.
  vite: { build: { target: "es2022" } },
});
