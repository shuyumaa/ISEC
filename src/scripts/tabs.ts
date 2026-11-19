import { focusgroupReady } from "./polyfills";

/**
 * Tabs built on `focusgroup="tablist"` (roles + arrow keys from the platform,
 * polyfilled where missing). Selection follows focus. Hidden panels use
 * hidden="until-found" so find-in-page can still reveal them.
 */
await focusgroupReady;

for (const root of document.querySelectorAll<HTMLElement>("[data-tabs]")) {
  const tabs = [...root.querySelectorAll<HTMLButtonElement>(":scope > .tablist > button")];
  const panels = tabs.map((t) => root.querySelector<HTMLElement>(`[role="tabpanel"][aria-labelledby="${t.id}"]`)!);

  const select = (tab: HTMLButtonElement) => {
    tabs.forEach((t, i) => {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.toggleAttribute("focusgroupstart", on);
      const panel = panels[i]!;
      if (on) {
        panel.removeAttribute("hidden");
        panel.tabIndex = 0;
      } else {
        // In browsers without until-found this becomes the boolean `hidden`.
        panel.setAttribute("hidden", "until-found");
        panel.removeAttribute("tabindex");
      }
    });
    tab.scrollIntoView({ block: "nearest", inline: "nearest", container: "nearest" } as ScrollIntoViewOptions);
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("focus", () => select(tab));
  }
  panels.forEach((panel, i) => panel.addEventListener("beforematch", () => select(tabs[i]!)));
}
