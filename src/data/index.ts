import { Temporal } from "temporal-polyfill";
import { events, ranking, rankingUpdated } from "./events";
import { matches } from "./matches";
import { articles } from "./news";
import { players, teams } from "./teams";
import type { EsportsEvent, Match, Player, PlayerMapStats, Team } from "./types";

export { articles, events, matches, players, ranking, rankingUpdated, teams };
export type * from "./types";

/**
 * The reference "now" for the mock data set. A real deployment would use
 * Temporal.Now and fetch live status from the API instead.
 */
export const TODAY = Temporal.PlainDate.from("2026-11-19");

const bySlug = <T extends { slug: string }>(list: T[]) => new Map(list.map((x) => [x.slug, x]));
const teamMap = bySlug(teams);
const playerMap = bySlug(players);
const eventMap = bySlug(events);

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Unknown ${what}`);
  return value;
}

export const team = (slug: string): Team => must(teamMap.get(slug), `team "${slug}"`);
export const player = (slug: string): Player => must(playerMap.get(slug), `player "${slug}"`);
export const event = (slug: string): EsportsEvent => must(eventMap.get(slug), `event "${slug}"`);
export const match = (id: string): Match => must(matches.find((m) => m.id === id), `match "${id}"`);

export const rosterOf = (teamSlug: string) => players.filter((p) => p.team === teamSlug);
export const rankOf = (teamSlug: string) => ranking.findIndex((r) => r.team === teamSlug) + 1 || undefined;

/* ---------------------------------- Time --------------------------------- */

/** A match start bound to its event's IANA zone (DST-safe). */
export function matchStart(m: Match): Temporal.ZonedDateTime {
  return Temporal.PlainDateTime.from(m.start).toZonedDateTime(event(m.event).timeZone, {
    disambiguation: "compatible",
  });
}

/** ISO instant string for <time datetime> and client-side conversion. */
export const matchInstant = (m: Match) => matchStart(m).toInstant().toString();

export const matchDate = (m: Match) => matchStart(m).toPlainDate();

const chronological = (a: Match, b: Match) => Temporal.ZonedDateTime.compare(matchStart(a), matchStart(b));

/* -------------------------------- Queries -------------------------------- */

export const liveMatches = () => matches.filter((m) => m.status === "live").sort(chronological);
export const upcomingMatches = () => matches.filter((m) => m.status === "upcoming").sort(chronological);
export const completedMatches = () =>
  matches.filter((m) => m.status === "completed").sort((a, b) => chronological(b, a));

export const matchesForEvent = (slug: string) => matches.filter((m) => m.event === slug).sort(chronological);
export const matchesForTeam = (slug: string) =>
  matches.filter((m) => m.teamA === slug || m.teamB === slug).sort((a, b) => chronological(b, a));

export function winnerOf(m: Match): string | undefined {
  if (m.status !== "completed") return undefined;
  return m.seriesA > m.seriesB ? m.teamA : m.teamB;
}

export function headToHead(a: string, b: string) {
  const games = completedMatches().filter(
    (m) => (m.teamA === a && m.teamB === b) || (m.teamA === b && m.teamB === a),
  );
  return {
    games,
    winsA: games.filter((m) => winnerOf(m) === a).length,
    winsB: games.filter((m) => winnerOf(m) === b).length,
  };
}

/** Group a list of matches by calendar day (in each event's own zone). */
export function groupByDay(list: Match[]) {
  const groups = new Map<string, { date: Temporal.PlainDate; matches: Match[] }>();
  for (const m of list) {
    const date = matchDate(m);
    const key = date.toString();
    if (!groups.has(key)) groups.set(key, { date, matches: [] });
    groups.get(key)!.matches.push(m);
  }
  return [...groups.values()];
}

/* ------------------------------ Player stats ----------------------------- */

export interface AggregatedStats {
  player: Player;
  maps: number;
  rounds: number;
  kills: number;
  deaths: number;
  kd: number;
  diff: number;
  adr: number;
  kast: number;
  hs: number;
  rating: number;
}

function aggregate(player: Player, entries: { stats: PlayerMapStats; rounds: number }[]): AggregatedStats {
  const sum = (f: (s: PlayerMapStats) => number) => entries.reduce((n, e) => n + f(e.stats), 0);
  const rounds = entries.reduce((n, e) => n + e.rounds, 0) || 1;
  const weighted = (f: (s: PlayerMapStats) => number) =>
    entries.reduce((n, e) => n + f(e.stats) * e.rounds, 0) / rounds;
  const kills = sum((s) => s.kills);
  const deaths = sum((s) => s.deaths);
  return {
    player,
    maps: entries.length,
    rounds,
    kills,
    deaths,
    kd: Number((kills / Math.max(1, deaths)).toFixed(2)),
    diff: kills - deaths,
    adr: Number(weighted((s) => s.adr).toFixed(1)),
    kast: Number(weighted((s) => s.kast).toFixed(1)),
    hs: Number(weighted((s) => s.hs).toFixed(1)),
    rating: Number(weighted((s) => s.rating).toFixed(2)),
  };
}

/** Career (data-set wide) stats for every player with at least `minMaps` completed maps. */
export function playerLeaderboard(minMaps = 1, include: (m: Match) => boolean = () => true): AggregatedStats[] {
  const perPlayer = new Map<string, { stats: PlayerMapStats; rounds: number }[]>();
  for (const m of matches.filter(include)) {
    for (const map of m.maps) {
      if (!map.stats || map.live) continue;
      const rounds = (map.scoreA ?? 0) + (map.scoreB ?? 0);
      for (const s of map.stats) {
        if (!perPlayer.has(s.player)) perPlayer.set(s.player, []);
        perPlayer.get(s.player)!.push({ stats: s, rounds });
      }
    }
  }
  return [...perPlayer]
    .map(([slug, entries]) => aggregate(player(slug), entries))
    .filter((a) => a.maps >= minMaps)
    .sort((a, b) => b.rating - a.rating);
}

export const playerSummary = (slug: string) => playerLeaderboard(0).find((a) => a.player.slug === slug);

/** Stats for one match, either a single map (index) or the whole series. */
export function matchStats(m: Match, mapIndex?: number): AggregatedStats[] {
  const maps = (mapIndex === undefined ? m.maps : [m.maps[mapIndex]]).filter((x) => x?.stats);
  const perPlayer = new Map<string, { stats: PlayerMapStats; rounds: number }[]>();
  for (const map of maps) {
    const rounds = Math.max(1, (map!.scoreA ?? 0) + (map!.scoreB ?? 0));
    for (const s of map!.stats!) {
      if (!perPlayer.has(s.player)) perPlayer.set(s.player, []);
      perPlayer.get(s.player)!.push({ stats: s, rounds });
    }
  }
  return [...perPlayer].map(([slug, entries]) => aggregate(player(slug), entries));
}

/* -------------------------------- Format --------------------------------- */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const money = (n: number) => usd.format(n);

export const formatDay = (d: Temporal.PlainDate, opts: Intl.DateTimeFormatOptions = {}) =>
  d.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", ...opts });

export function formatRange(startISO: string, endISO: string) {
  const s = Temporal.PlainDate.from(startISO);
  const e = Temporal.PlainDate.from(endISO);
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  // formatRange needs Date objects; PlainDate → UTC midnight keeps the calendar day intact.
  const toDate = (d: Temporal.PlainDate) => new Date(d.toZonedDateTime("UTC").epochMilliseconds);
  return fmt.formatRange(toDate(s), toDate(e));
}

export const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
