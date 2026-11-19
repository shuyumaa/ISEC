import { temporalReady } from "./polyfills";

/**
 * Rewrites server-rendered venue times into the viewer's own time zone and
 * keeps countdowns ticking. Times are instants; Temporal handles the zone math.
 */
const Temporal = await temporalReady;

const FORMATS: Record<string, Intl.DateTimeFormatOptions> = {
  time: { hour: "2-digit", minute: "2-digit" },
  date: { day: "numeric", month: "short" },
  datetime: { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" },
};

const here = Temporal.Now.timeZoneId();

for (const el of document.querySelectorAll<HTMLTimeElement>("time[data-local-time]")) {
  const zoned = Temporal.Instant.from(el.dateTime).toZonedDateTimeISO(here);
  el.textContent = zoned.toLocaleString(undefined, FORMATS[el.dataset.localTime ?? "time"]);
}

const countdowns = [...document.querySelectorAll<HTMLElement>("[data-countdown]")];

type Duration = InstanceType<typeof Temporal.Duration>;
const hasDurationFormat = "DurationFormat" in Intl;

function format(d: Duration): string {
  if (hasDurationFormat) {
    // @ts-expect-error -- Intl.DurationFormat is not yet in TypeScript's lib.
    return new Intl.DurationFormat(undefined, { style: "narrow" }).format(d);
  }
  const parts: string[] = [];
  if (d.days) parts.push(`${d.days}d`);
  if (d.hours) parts.push(`${d.hours}h`);
  if (d.minutes) parts.push(`${d.minutes}m`);
  parts.push(`${d.seconds}s`);
  return parts.join(" ");
}

function tick() {
  const now = Temporal.Now.zonedDateTimeISO(here);
  for (const el of countdowns) {
    const target = Temporal.Instant.from(el.dataset.countdown!).toZonedDateTimeISO(here);
    const left = now.until(target, { largestUnit: "day", smallestUnit: "second" });
    el.textContent = left.sign > 0 ? format(left) : "Starting";
  }
}

if (countdowns.length) {
  tick();
  let timer = setInterval(tick, 1000);
  // Don't burn CPU in background tabs.
  document.addEventListener("visibilitychange", () => {
    clearInterval(timer);
    if (!document.hidden) {
      tick();
      timer = setInterval(tick, 1000);
    }
  });
}
