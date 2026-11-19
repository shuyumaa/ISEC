/**
 * Conditional polyfills. Each is fetched only when the native feature is
 * missing, so modern browsers download nothing extra.
 */
export const popoverReady: Promise<void> = Object.hasOwn(HTMLElement.prototype, "popover")
  ? Promise.resolve()
  : import("@oddbird/popover-polyfill").then(() => undefined);

export const focusgroupReady: Promise<void> = Object.hasOwn(HTMLElement.prototype, "focusGroup")
  ? Promise.resolve()
  : import("@microsoft/focusgroup-polyfill").then(({ polyfillBodyAndObserve }) => {
      polyfillBodyAndObserve();
    });

type TemporalNS = typeof import("temporal-polyfill").Temporal;

export const temporalReady: Promise<TemporalNS> =
  typeof (globalThis as { Temporal?: TemporalNS }).Temporal !== "undefined"
    ? Promise.resolve((globalThis as unknown as { Temporal: TemporalNS }).Temporal)
    : import("temporal-polyfill").then((m) => {
        (globalThis as unknown as { Temporal: TemporalNS }).Temporal = m.Temporal;
        return m.Temporal;
      });

/** Invoker commands (command / commandfor) for opening dialogs declaratively. */
export const commandsReady: Promise<void> =
  "commandForElement" in HTMLButtonElement.prototype ? Promise.resolve() : import("invokers-polyfill").then(() => undefined);
