/*
 * Trusted Types: the only HTML sink on the site is the DOMParser below, fed the
 * current page re-rendered by our own server (same origin, text/html, checked
 * where it is fetched): the same markup a reload would produce. The policy is module-private
 * and the CSP allows no other policy name. Parsed <script>s never execute.
 */
type TT = { createPolicy(n: string, r: { createHTML(s: string): string }): { createHTML(s: string): string } };
const tt = (globalThis as { trustedTypes?: TT }).trustedTypes;
let livePolicy: ReturnType<TT["createPolicy"]> | undefined;
try {
  livePolicy = tt?.createPolicy("isec-live", { createHTML: (html) => html });
} catch {
  /* already created (module evaluated twice): live updates fall back to reloads */
}
const toTrustedHTML = (html: string) => (livePolicy ? livePolicy.createHTML(html) : html) as string;

/**
 * Live sync client.
 *  1. Subscribes to /api/live (Server-Sent Events; EventSource reconnects by itself).
 *  2. When a change arrives, finds the [data-live] regions on this page whose
 *     data-deps match (e.g. "match:2380111", "match:*"), re-fetches this page
 *     and swaps just those regions in place: no reload, scroll and focus kept.
 *  3. Fires "isec:hydrate" on each swapped region so behaviours (local times,
 *     countdowns, tabs, sortable tables) re-attach.
 */
interface Change {
  kind: string;
  id: string;
}

const syncStatus = document.querySelector<HTMLElement>("[data-sync-status]");
const setStatus = (state: "live" | "connecting" | "offline") => {
  if (!syncStatus) return;
  syncStatus.dataset.state = state;
  syncStatus.hidden = false;
  syncStatus.title = { live: "Live updates on", connecting: "Reconnecting…", offline: "Live updates paused" }[state];
};

const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;

function matches(region: HTMLElement, changes: Change[]) {
  const deps = (region.dataset.deps ?? "").split(/\s+/).filter(Boolean);
  return changes.some((c) => deps.includes(`${c.kind}:${c.id}`) || deps.includes(`${c.kind}:*`) || deps.includes("*"));
}

function schedule(changes: Change[]) {
  for (const region of document.querySelectorAll<HTMLElement>("[data-live]")) {
    if (matches(region, changes)) pending.add(region.dataset.live!);
  }
  if (!pending.size) return;
  clearTimeout(timer);
  timer = setTimeout(refresh, 200);
}

function refreshAll() {
  for (const region of document.querySelectorAll<HTMLElement>("[data-live]")) pending.add(region.dataset.live!);
  clearTimeout(timer);
  timer = setTimeout(refresh, 300);
}

async function refresh() {
  if (inFlight) {
    timer = setTimeout(refresh, 200);
    return;
  }
  inFlight = true;
  const keys = [...pending];
  pending.clear();
  try {
    const res = await fetch(location.href, { headers: { "X-ISEC-Live": "1" }, cache: "no-store" });
    if (res.status === 404) {
      location.reload();
      return;
    }
    if (!res.ok || new URL(res.url).origin !== location.origin || !res.headers.get("content-type")?.startsWith("text/html")) return;
    if (tt && !livePolicy) {
      location.reload();
      return;
    }
    const doc = new DOMParser().parseFromString(toTrustedHTML(await res.text()), "text/html");
    for (const key of keys) {
      const current = document.querySelector<HTMLElement>(`[data-live="${CSS.escape(key)}"]`);
      const next = doc.querySelector<HTMLElement>(`[data-live="${CSS.escape(key)}"]`);
      if (!current || !next) continue;
      if (current.innerHTML === next.innerHTML) continue;
      // Never clobber something the user is editing.
      const active = document.activeElement;
      const editing = current.querySelector("form[data-dirty]") || (active && current.contains(active) && active.matches("input, select, textarea"));
      if (editing) continue;
      swap(current, next);
    }
  } catch {
    /* network blip: the next change or reconnect will catch up */
  } finally {
    inFlight = false;
  }
}

function swap(current: HTMLElement, next: HTMLElement) {
  // Remember UI state that a re-render would otherwise reset.
  const focusedId = current.contains(document.activeElement) ? document.activeElement?.id : undefined;
  const selectedTabs = [...current.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]')].map((t) => t.id);
  const announce = current.dataset.announce !== undefined ? next.querySelector<HTMLElement>("[data-announce-text]")?.textContent : undefined;

  const fresh = document.importNode(next, true);
  current.replaceWith(fresh);

  for (const id of selectedTabs) document.getElementById(id)?.click();
  if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  fresh.dispatchEvent(new CustomEvent("isec:hydrate", { bubbles: true }));
  fresh.classList.add("just-updated");
  setTimeout(() => fresh.classList.remove("just-updated"), 1200);

  if (announce) {
    const live = document.getElementById("live-announcer");
    if (live) live.textContent = announce.trim();
  }
}

function connect() {
  if (!("EventSource" in window)) return;
  setStatus("connecting");
  const source = new EventSource("/api/live");
  let lastVersion = 0;

  source.addEventListener("hello", (e) => {
    const { version } = JSON.parse((e as MessageEvent).data) as { version: number };
    setStatus("live");
    // Reconnected after missing changes: refresh everything live on the page.
    if (lastVersion && version !== lastVersion) refreshAll();
    lastVersion = version;
  });

  source.addEventListener("change", (e) => {
    const set = JSON.parse((e as MessageEvent).data) as { version: number; changes: Change[] };
    lastVersion = set.version;
    schedule(set.changes);
  });

  source.addEventListener("error", () => setStatus(source.readyState === EventSource.CLOSED ? "offline" : "connecting"));

  // Pause the stream in background tabs; catch up on return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      source.close();
      setStatus("offline");
    } else if (source.readyState === EventSource.CLOSED) {
      connectAgain();
    }
  }, { once: true });

  function connectAgain() {
    connect();
    refreshAll(); // we may have missed updates while hidden
  }
}

if (document.querySelector("[data-live]")) connect();
