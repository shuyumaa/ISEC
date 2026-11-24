/*
 * Bulk selection for admin tables marked [data-bulk]: a "select all" box with
 * an indeterminate state, the live count in the batch bar and the confirm
 * dialog, and Cancel. Visibility of the bar itself is CSS (:has), so without
 * JavaScript ticking rows and deleting still works.
 */
function wireBulk(root: HTMLElement) {
  const boxes = () => [...root.querySelectorAll<HTMLInputElement>('input[name="ids"]')];
  const update = () => {
    const all = boxes();
    const n = all.filter((b) => b.checked).length;
    for (const c of root.querySelectorAll("[data-count]")) c.textContent = String(n);
    const head = root.querySelector<HTMLInputElement>("[data-all]");
    if (head) {
      head.checked = n > 0 && n === all.length;
      head.indeterminate = n > 0 && n < all.length;
    }
  };
  root.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.matches("[data-all]")) for (const b of boxes()) b.checked = t.checked;
    update();
  });
  root.querySelector("[data-clear]")?.addEventListener("click", () => {
    for (const b of boxes()) b.checked = false;
    update();
  });
  update();
}
for (const root of document.querySelectorAll<HTMLElement>("[data-bulk]")) wireBulk(root);
export {};
