/**
 * Two-state colour-scheme toggle.
 * State lives in <meta name="color-scheme"> (CSS maps it onto `color-scheme`),
 * persisted in localStorage only while it differs from the system preference.
 */
const KEY = "color-scheme";
const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')!;
const systemDark = matchMedia("(prefers-color-scheme: dark)");

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function apply(value: string | null) {
  meta.content = value ?? "light dark";
}

function rendered(): "light" | "dark" {
  const s = stored() ?? meta.content;
  if (s === "light" || s === "dark") return s;
  return systemDark.matches ? "dark" : "light";
}

function toggle() {
  const target = rendered() === "dark" ? "light" : "dark";
  const system = systemDark.matches ? "dark" : "light";
  // Going back to what the OS already shows = undo the override, never pin it.
  const value = target === system ? null : target;
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: still apply for this page view */
  }
  apply(value);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")) {
  button.addEventListener("click", toggle);
}

// Stay in sync with other tabs.
addEventListener("storage", (e) => {
  if (e.key === KEY) apply(e.newValue);
});
