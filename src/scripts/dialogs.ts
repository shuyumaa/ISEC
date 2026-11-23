/*
 * Modal <dialog> helpers (Modern Web Guidance: dialog, animate-to-from-top-layer).
 *  - Exit animation fallback: where `overlay` / discrete `display` transitions
 *    are missing (Firefox, Safari), closing sets [data-closing], waits for the
 *    CSS exit transition, then closes. Esc, light dismiss and command="close"
 *    are all routed through it.
 *  - Light-dismiss fallback where `closedby="any"` is unsupported.
 */

let displayTransition: boolean | undefined;
function canTransitionDisplay() {
  if (displayTransition !== undefined) return displayTransition;
  if (!window.CSS?.supports?.("transition-behavior", "allow-discrete") || !document.body) return false;
  const probe = document.createElement("div");
  // Shorthand on purpose: browsers that can't parse allow-discrete drop it and the probe reads false.
  probe.style.cssText = "transition: display 1s allow-discrete !important; display: block;";
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = "none";
  displayTransition = getComputedStyle(probe).display === "block";
  probe.remove();
  return displayTransition;
}
const supportsTopLayerExit = () => Boolean(window.CSS?.supports?.("overlay", "auto")) && canTransitionDisplay();

async function closeAnimated(dialog: HTMLDialogElement) {
  if (!supportsTopLayerExit()) {
    dialog.setAttribute("data-closing", "");
    const animations = dialog.getAnimations({ subtree: true });
    if (animations.length) {
      await Promise.race([Promise.allSettled(animations.map((a) => a.finished)), new Promise((r) => setTimeout(r, 2000))]);
    }
    if (!dialog.hasAttribute("data-closing")) return;
    dialog.removeAttribute("data-closing");
  }
  dialog.close();
}

const outside = (e: PointerEvent, el: Element) => {
  const r = el.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
};

function wire(dialog: HTMLDialogElement) {
  if (dialog.dataset.wired) return;
  dialog.dataset.wired = "1";
  if (!supportsTopLayerExit()) {
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      void closeAnimated(dialog);
    });
    // Invoker command="close" fires a cancelable "command" event on the dialog.
    dialog.addEventListener("command", (e) => {
      if ((e as Event & { command?: string }).command !== "close") return;
      e.preventDefault();
      void closeAnimated(dialog);
    });
  }
  if (!("closedBy" in HTMLDialogElement.prototype) && dialog.getAttribute("closedby") === "any") {
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (e) => {
      pressedOutside = outside(e, dialog);
    });
    // Press and release both outside, so a text-selection drag ending on the backdrop doesn't dismiss.
    dialog.addEventListener("pointerup", (e) => {
      if (pressedOutside && outside(e, dialog)) void closeAnimated(dialog);
    });
  }
}

const wireAll = (root: ParentNode = document) => root.querySelectorAll<HTMLDialogElement>("dialog").forEach(wire);
wireAll();
document.addEventListener("isec:hydrate", (e) => wireAll(e.target as ParentNode));
