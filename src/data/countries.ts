import list from "flag-icons/country.json";

/** Names used in sport instead of the dataset's (Olympic convention). */
const NAMES: Record<string, string> = { TW: "Chinese Taipei" };

/** ISO 3166-1 alpha-2 countries and regions (from flag-icons), sorted by name, for pickers and labels. */
export const COUNTRIES: { code: string; name: string }[] = (list as { code: string; name: string; iso: boolean }[])
  .filter((c) => c.iso && /^[a-z]{2}$/.test(c.code))
  .map((c) => ({ code: c.code.toUpperCase(), name: NAMES[c.code.toUpperCase()] ?? c.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

const byCode = new Map(COUNTRIES.map((c) => [c.code, c.name]));

export const countryName = (code?: string) => (code ? (byCode.get(code.toUpperCase()) ?? code.toUpperCase()) : "");
export const isCountry = (code?: string) => !!code && byCode.has(code.toUpperCase());
/** URL of the flag image for a country code (served by src/pages/flags/[code].ts). */
export const flagUrl = (code?: string) => (isCountry(code) ? `/flags/${code!.toLowerCase()}.svg` : undefined);
