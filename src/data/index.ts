import { Temporal } from "temporal-polyfill";
import { snapshot } from "../server/db";
import type { EsportsEvent, MapResult, Match, Player, PlayerMapStats, Team } from "./types";

export type * from "./types";

/*
 * Read API for pages. Everything resolves against the current database
 * snapshot, which is rebuilt after each admin write, so a page render always
 * sees one consistent version of the data.
 */

export const getTeams = () => snapshot().teams;
export const getPlayers = () => snapshot().players;
export const getEvents = () => snapshot().events;
export const getMatches = () => snapshot().matches;
export const getArticles = () =>
  [...snapshot().articles].sort((a, b) => b.published.localeCompare(a.published));
export const getRanking = () => snapshot().ranking;
export const getRankingUpdated = () => snapshot().meta.rankingUpdated;
export const dataVersion = () => snapshot().version;

const indexes = new WeakMap<object, { teams: Map<string, Team>; players: Map<string, Player>; events: Map<string, EsportsEvent> }>();
function idx() {
  const s = snapshot();
  let i = indexes.get(s);
  if (!i) {
    i = {
      teams: new Map(s.teams.map((x) => [x.slug, x])),
      players: new Map(s.players.map((x) => [x.slug, x])),
      events: new Map(s.events.map((x) => [x.slug, x])),
    };
    indexes.set(s, i);
  }
  return i;
}

/** Placeholder used when a record was deleted but is still referenced. */
const unknownTeam = (slug: string): Team => ({ slug, name: slug, tag: "?", country: "", countryCode: "", founded: 0, coach: "" });

export const team = (slug: string): Team => idx().teams.get(slug) ?? unknownTeam(slug);
export const findTeam = (slug: string) => idx().teams.get(slug);
export const player = (slug: string): Player =>
  idx().players.get(slug) ?? { slug, nickname: slug, firstName: "", lastName: "", team: "", role: "Rifler", countryCode: "", age: 0 };
export const findPlayer = (slug: string) => idx().players.get(slug);
export const event = (slug: string): EsportsEvent =>
  idx().events.get(slug) ?? {
    slug, name: slug, tier: "Open", status: "upcoming", startDate: "2026-01-01", endDate: "2026-01-01",
    timeZone: "UTC", location: "", online: true, prizePool: 0, teams: [], format: [], prizes: [],
  };
export const findEvent = (slug: string) => idx().events.get(slug);
export const findMatch = (id: string) => getMatches().find((m) => m.id === id);
export const findArticle = (slug: string) => snapshot().articles.find((a) => a.slug === slug);

export const rosterOf = (teamSlug: string) => getPlayers().filter((p) => p.team === teamSlug);
export const rankOf = (teamSlug: string) => getRanking().findIndex((r) => r.team === teamSlug) + 1 || undefined;

/* ------------------------------ Match rules ------------------------------ */

/** A map is decided once it is no longer live and one side has won (MR12, OT MR3). */
export function mapDecided(map: MapResult): boolean {
  if (map.live || map.scoreA === undefined || map.scoreB === undefined) return false;
  const hi = Math.max(map.scoreA, map.scoreB);
  const lo = Math.min(map.scoreA, map.scoreB);
  if (hi === 13 && lo <= 11) return true;
  // Overtime: first to 4 of 6 rounds per OT block, i.e. win by 2 at 16, 19, 22…
  return hi >= 16 && hi - lo >= 2 && (hi - 13) % 3 === 0;
}

/** Series score derived from decided maps (Bo1 counts the single map). */
export function seriesScore(m: Pick<Match, "maps">): [number, number] {
  let a = 0;
  let b = 0;
  for (const map of m.maps) {
    if (!mapDecided(map)) continue;
    if (map.scoreA! > map.scoreB!) a++;
    else b++;
  }
  return [a, b];
}

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

export const liveMatches = () => getMatches().filter((m) => m.status === "live").sort(chronological);
export const upcomingMatches = () => getMatches().filter((m) => m.status === "upcoming").sort(chronological);
export const completedMatches = () =>
  getMatches().filter((m) => m.status === "completed").sort((a, b) => chronological(b, a));

export const matchesForEvent = (slug: string) => getMatches().filter((m) => m.event === slug).sort(chronological);
export const matchesForTeam = (slug: string) =>
  getMatches().filter((m) => m.teamA === slug || m.teamB === slug).sort((a, b) => chronological(b, a));

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
  for (const m of getMatches().filter(include)) {
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
