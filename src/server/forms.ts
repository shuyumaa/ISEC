/**
 * Server-side form parsing. Browser constraints (required, min, pattern…) are
 * UX only; everything is re-validated here before it reaches the database.
 */
export class FormError extends Error {
  constructor(
    message: string,
    public field?: string,
  ) {
    super(message);
  }
}

type Opts = { required?: boolean; max?: number; label?: string };

export function text(form: FormData, name: string, { required = false, max = 500, label = name }: Opts = {}): string {
  const raw = form.get(name);
  const v = typeof raw === "string" ? raw.trim() : "";
  if (required && !v) throw new FormError(`${label} is required.`, name);
  if (v.length > max) throw new FormError(`${label} must be at most ${max} characters.`, name);
  return v;
}

export function optionalText(form: FormData, name: string, opts: Opts = {}): string | undefined {
  return text(form, name, opts) || undefined;
}

export function int(
  form: FormData,
  name: string,
  { required = false, min = -Infinity, max = Infinity, label = name }: { required?: boolean; min?: number; max?: number; label?: string } = {},
): number | undefined {
  const v = text(form, name, { required, label });
  if (!v) return undefined;
  if (!/^-?\d+$/.test(v)) throw new FormError(`${label} must be a whole number.`, name);
  const n = Number(v);
  if (n < min || n > max) throw new FormError(`${label} must be between ${min} and ${max}.`, name);
  return n;
}

export function num(
  form: FormData,
  name: string,
  { required = false, min = -Infinity, max = Infinity, label = name }: { required?: boolean; min?: number; max?: number; label?: string } = {},
): number | undefined {
  const v = text(form, name, { required, label });
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new FormError(`${label} must be a number.`, name);
  if (n < min || n > max) throw new FormError(`${label} must be between ${min} and ${max}.`, name);
  return n;
}

export function oneOf<T extends string>(form: FormData, name: string, options: readonly T[], label = name): T {
  const v = text(form, name, { required: true, label });
  if (!options.includes(v as T)) throw new FormError(`${label} has an invalid value.`, name);
  return v as T;
}

export const bool = (form: FormData, name: string) => form.get(name) === "on" || form.get(name) === "true";

export function isoDate(form: FormData, name: string, label = name): string {
  const v = text(form, name, { required: true, label });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new FormError(`${label} must be a date (YYYY-MM-DD).`, name);
  return v;
}

/** <input type="datetime-local"> value, e.g. 2026-11-19T15:00 */
export function localDateTime(form: FormData, name: string, label = name): string {
  const v = text(form, name, { required: true, label });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) throw new FormError(`${label} must be a date and time.`, name);
  return v.slice(0, 16);
}

export function timeZone(form: FormData, name: string, label = name): string {
  const v = text(form, name, { required: true, label });
  try {
    new Intl.DateTimeFormat("en", { timeZone: v });
  } catch {
    throw new FormError(`${label} must be an IANA time zone such as Europe/Berlin.`, name);
  }
  return v;
}

export const lines = (form: FormData, name: string) =>
  text(form, name, { max: 20000 })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** Paragraphs separated by blank lines. */
export const paragraphs = (form: FormData, name: string) =>
  text(form, name, { max: 50000 })
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s*\r?\n\s*/g, " ").trim())
    .filter(Boolean);

const RESERVED = new Set(["new", "admin", "api", "media"]);

export const slugify = (s: string) => {
  const slug = s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  // Never collide with routes such as /admin/news/new/.
  return RESERVED.has(slug) || !slug ? `${slug || "item"}-1` : slug;
};
