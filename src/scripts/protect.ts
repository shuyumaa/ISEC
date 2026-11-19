/**
 * Event-level copy protection for the public site (the CSS in protect.css
 * already blocks selection and dragging without JavaScript). Form fields keep
 * normal behaviour so search boxes, inputs and accessibility tools still work.
 *
 * Note: no web page can stop screenshots, devtools or a proxy; this removes
 * the casual ways to copy text and images.
 */
if (!document.body.classList.contains("admin")) {
  const editable = (t: EventTarget | null) =>
    t instanceof Element && !!t.closest("input, textarea, select, [contenteditable='true']");

  for (const type of ["copy", "cut", "contextmenu", "dragstart", "selectstart"] as const) {
    document.addEventListener(type, (e) => {
      if (!editable(e.target)) e.preventDefault();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || editable(e.target)) return;
    // Save page, print, select all, copy, view source.
    if (["s", "p", "a", "c", "u"].includes(e.key.toLowerCase())) e.preventDefault();
  });
}
