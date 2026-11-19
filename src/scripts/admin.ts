import { commandsReady } from "./polyfills";

/**
 * Admin progressive enhancement. Every form works as a normal POST without
 * JavaScript; forms marked [data-enhance] are submitted with fetch instead so
 * live controls (round +1 etc.) respond instantly without a page reload. The
 * resulting change is pushed back to every open page through live sync.
 */
await commandsReady;

const toast = document.getElementById("admin-toast")!;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function notify(message: string, kind: "ok" | "error" = "ok") {
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), kind === "error" ? 6000 : 2500);
}

document.addEventListener("submit", async (e) => {
  const form = e.target as HTMLFormElement;
  if (!form.matches("form[data-enhance]")) return;
  e.preventDefault();
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  // Read the form first: a disabled submitter is left out of FormData.
  const body = new FormData(form, submitter);
  // Prevent double posts while the request is in flight.
  if (submitter) submitter.disabled = true;
  try {
    const res = await fetch(form.action || location.href, {
      method: "POST",
      body,
      headers: { "X-ISEC-Enhanced": "1" },
    });
    const data = (await res.json()) as { ok: boolean; message?: string; error?: string; redirect?: string };
    if (!data.ok) notify(data.error ?? "Not saved.", "error");
    else if (data.redirect && new URL(data.redirect, location.href).pathname !== location.pathname) location.assign(data.redirect);
    else notify(data.message ?? "Saved");
  } catch {
    notify("Network error — not saved.", "error");
  } finally {
    if (submitter) submitter.disabled = false;
  }
});

// Move focus to the first invalid field when native validation blocks a submit.
document.addEventListener(
  "invalid",
  (e) => {
    const field = e.target as HTMLElement;
    const form = field.closest("form");
    if (form && form.querySelector(":invalid") === field) field.focus();
  },
  true,
);

// Mark forms with unsaved edits so live sync never replaces them mid-typing.
document.addEventListener("input", (e) => {
  (e.target as HTMLElement).closest("form")?.setAttribute("data-dirty", "");
});

/* Copy buttons: <button command="--copy" commandfor="<id>"> (invoker commands,
   click fallback where unsupported). Feedback goes to the sibling role=status. */
const timers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();
let lastMessage = "";

function report(button: HTMLButtonElement, ok: boolean) {
  const tip = button.nextElementSibling as HTMLElement | null;
  if (!tip) return;
  clearTimeout(timers.get(button));
  let message = ok ? "Copied" : "Copy failed — select the text and copy it manually";
  if (message === lastMessage) message += "\u00A0"; // so VoiceOver repeats it
  lastMessage = message;
  tip.textContent = "";
  requestAnimationFrame(() => (tip.textContent = message));
  timers.set(button, setTimeout(() => (tip.textContent = ""), 2500));
}

async function copy(button: HTMLButtonElement, target: Element) {
  const text = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement ? target.value : (target as HTMLElement).innerText.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    report(button, true);
  } catch {
    report(button, false);
  }
}

if ("CommandEvent" in window) {
  document.addEventListener(
    "command",
    (e) => {
      const ev = e as Event & { command: string; source: HTMLButtonElement };
      if (ev.command === "--copy") void copy(ev.source, ev.target as Element);
    },
    true,
  );
} else {
  document.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('button[command="--copy"]');
    const target = button && document.getElementById(button.getAttribute("commandfor") ?? "");
    if (button && target) void copy(button, target);
  });
}
