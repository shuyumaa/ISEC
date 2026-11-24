import { config } from "zod";

// Zod compiles validators with `Function()` when it can; the strict CSP (and
// Trusted Types) forbid that and log a violation. Imported before anything
// that builds zod schemas, so every schema is created in no-eval mode.
config({ jitless: true });
