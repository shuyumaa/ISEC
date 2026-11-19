import { popoverReady } from "./polyfills";

/**
 * Responsive primary navigation: one <ul>, shown inline when the whole header
 * row fits, otherwise a native popover opened from the Menu button.
 * No fixed breakpoint — the row is measured, so new links or larger text
 * move the switch point automatically.
 */
await popoverReady;

const header = document.querySelector<HTMLElement>(".site-header");
const inner = header?.querySelector<HTMLElement>(".header-inner");
const menu = header?.querySelector<HTMLElement>("#site-menu");

if (header && inner && menu) {
  let lastWidth = 0;

  const isOpen = () => {
    try {
      return menu.matches(":popover-open");
    } catch {
      return menu.classList.contains(":popover-open");
    }
  };

  const update = () => {
    const width = header.clientWidth;
    const wide = header.classList.contains("is-wide");
    // While collapsed, only re-measure when the header grew (avoids thrash).
    if (!wide && width <= lastWidth) {
      lastWidth = width;
      return;
    }
    lastWidth = width;

    const wasOpen = !wide && isOpen();
    header.classList.add("is-measuring", "is-wide");
    menu.removeAttribute("popover");
    const fits = inner.scrollWidth <= inner.clientWidth;

    if (!fits) {
      header.classList.remove("is-wide");
      menu.setAttribute("popover", "auto");
      if (wasOpen) menu.showPopover();
    }
    requestAnimationFrame(() => header.classList.remove("is-measuring"));
  };

  const observer = new ResizeObserver(update);
  observer.observe(header);
  observer.observe(menu);
}
