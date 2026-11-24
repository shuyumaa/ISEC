import { Temporal } from "temporal-polyfill";
import { snapshot } from "../server/db";
import { eloSettings, playerElo, rankingAsOf, teamTable } from "./elo";
import type { EsportsEvent, MapResult, Match, Player, PlayerMapStats, Role, Team } from "./types";

export type * from "./types";
export * from "./elo";
export * from "./brackets";
export * from "./gsl";
export { COUNTRIES, countryName, flagUrl, isCountry } from "./countries";

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
  snapshot().articles.toSorted((a, b) => b.published.localeCompare(a.published));
/** Computed from results (team Elo + admin adjustment); see src/data/elo.ts. */
export const getRanking = () => teamTable();
export const getRankingUpdated = () => rankingAsOf();
export const dataVersion = () => snapshot().version;
export const getSeasons = () => snapshot().seasons;
export const getSettings = () => snapshot().settings;

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
/** An empty slug is a team still to be decided ("TBD"); a missing one was deleted. */
const unknownTeam = (slug: string): Team =>
  slug ? { slug, name: slug, tag: "?", country: "", countryCode: "", founded: 0, coach: "" } : { slug: "", name: "TBD", tag: "TBD", country: "", countryCode: "", founded: 0, coach: "" };
/** Both teams are known (not TBD). */
export const hasTeams = (m: Pick<Match, "teamA" | "teamB">) => Boolean(m.teamA && m.teamB);

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

/** Players on a team's books: the starting five first, then benched players. */
export const rosterOf = (teamSlug: string) =>
  getPlayers()
    .filter((p) => p.team === teamSlug && p.status !== "free" && p.status !== "retired")
    .toSorted(
      (a, b) =>
        Number(a.status === "benched") - Number(b.status === "benched") ||
        (a.order ?? 999) - (b.order ?? 999) ||
        a.nickname.localeCompare(b.nickname),
    );
export const activeRoster = (teamSlug: string) => rosterOf(teamSlug).filter((p) => p.status !== "benched");
export const getTransfers = () => snapshot().transfers;
export const getRequests = () => snapshot().requests;

const teamAtCache = new WeakMap<object, Map<string, { date: string; team: string }[]>>();
/**
 * The team a player was on at a date (YYYY-MM-DD), from the transfer history;
 * falls back to the current team when no move is recorded. Keeps old results
 * on the right side after a transfer.
 */
export function teamAt(playerSlug: string, date: string): string {
  const s = snapshot();
  let byPlayer = teamAtCache.get(s);
  if (!byPlayer) {
    byPlayer = new Map();
    for (const t of s.transfers.toReversed()) {
      if (!byPlayer.has(t.player)) byPlayer.set(t.player, []);
      byPlayer.get(t.player)!.push({ date: t.date, team: t.to });
    }
    teamAtCache.set(s, byPlayer);
  }
  const moves = byPlayer.get(playerSlug);
  if (!moves?.length) return player(playerSlug).team;
  let current: string | undefined;
  for (const m of moves) if (m.date <= date) current = m.team;
  // Before the first recorded move: the team they moved away from, if any.
  return current ?? s.transfers.findLast((t) => t.player === playerSlug)?.from ?? player(playerSlug).team;
}

/**
 * Players who can have stats in a match: anyone already in a map's stats,
 * anyone on either team on the match day, and both current rosters. Team A
 * players first. Keeps transferred players' old stats editable.
 */
export function matchRoster(m: Match): Player[] {
  const date = m.start.slice(0, 10);
  const inStats = new Set(m.maps.flatMap((x) => x.stats?.map((st) => st.player) ?? []));
  const sideOf = (p: Player) => {
    const then = teamAt(p.slug, date);
    if (then === m.teamA || then === m.teamB) return then;
    if (p.team === m.teamA || p.team === m.teamB) return p.team;
    return inStats.has(p.slug) ? "?" : undefined;
  };
  return getPlayers()
    .map((p) => ({ p, side: sideOf(p) }))
    .filter((x) => x.side && (x.p.status !== "retired" || inStats.has(x.p.slug)))
    .sort((x, y) => Number(x.side !== m.teamA) - Number(y.side !== m.teamA) || x.p.nickname.localeCompare(y.p.nickname))
    .map((x) => x.p);
}

/** Split a map's stats into the two lineups, by who each player played for on that day. */
export function lineups<T extends { player: string }>(m: Match, stats: T[]) {
  const date = m.start.slice(0, 10);
  const side = (st: T) => {
    const t = teamAt(st.player, date);
    return t === m.teamA ? "A" : t === m.teamB ? "B" : undefined;
  };
  return { a: stats.filter((st) => side(st) === "A"), b: stats.filter((st) => side(st) === "B") };
}
export const transfersFor = (playerSlug: string) => getTransfers().filter((t) => t.player === playerSlug);
export const teamTransfers = (teamSlug: string) => getTransfers().filter((t) => t.from === teamSlug || t.to === teamSlug);
/** Human label for one end of a move ("Bench", "No team", "Retired" or the team). */
export function moveLabel(teamSlug: string, status: import("./types").PlayerStatus) {
  if (status === "retired") return "Retired";
  if (!teamSlug) return "No team";
  return status === "benched" ? "Bench" : "";
}
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
  /* Perfect World extras (0 when the source never provided them). */
  rws: number;
  firstKills: number;
  firstDeaths: number;
  clutchesWon: number;
  clutchesPlayed: number;
  utilityDamage: number;
  flashAssists: number;
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
    rws: Number(weighted((s) => s.rws ?? 0).toFixed(2)),
    firstKills: sum((s) => s.firstKills ?? 0),
    firstDeaths: sum((s) => s.firstDeaths ?? 0),
    clutchesWon: sum((s) => s.clutchesWon ?? 0),
    clutchesPlayed: sum((s) => s.clutchesPlayed ?? 0),
    utilityDamage: sum((s) => s.utilityDamage ?? 0),
    flashAssists: sum((s) => s.flashAssists ?? 0),
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

/* ---------------------------- Player attributes --------------------------- */

/**
 * HLTV-style attribute profile, adapted to what Perfect World (完美世界) reports.
 * Each attribute is a 0–100 score = the player's percentile among all ranked
 * players, next to the raw value it comes from:
 *   Firepower → ADR · Entrying → K/D · Opening → RWS · Trading → KAST
 *   Clutching → clutch win %, from raw clutch wins / attempts
 *   Utility   → utility damage + 25 per flash assist, per round
 * Clutch % is shrunk toward the field average for small samples (Bayesian
 * prior of 5 attempts) so one lucky 1v1 doesn't read as a 100% clutcher.
 */
export interface Attribute {
  key: string;
  label: string;
  /** What the raw value is, e.g. "ADR". */
  source: string;
  raw: string;
  score: number; // 0–100 percentile
}

function percentile(value: number, all: number[]) {
  if (all.length <= 1) return 50;
  const below = all.filter((v) => v < value).length;
  const equal = all.filter((v) => v === value).length;
  return Math.round(((below + (equal - 1) / 2) / (all.length - 1)) * 100);
}

const clutchRate = (s: AggregatedStats, prior: number) => (s.clutchesWon + prior * 5) / (s.clutchesPlayed + 5);
const utilityPerRound = (s: AggregatedStats) => (s.utilityDamage + 25 * s.flashAssists) / Math.max(1, s.rounds);

/** Match filter shared by attributes and the player rank. */
export function matchFilter(f: RankFilters = {}) {
  const season = f.season ? getSeasons().find((s) => s.slug === f.season) : undefined;
  const inRange = (day: string) => !season || (day >= season.startDate && day <= season.endDate);
  return {
    season,
    inRange,
    include: (m: Match) => (!f.event || m.event === f.event) && inRange(m.start.slice(0, 10)),
  };
}

/** The field a player is compared against, and the player's own line. */
export function comparison(slug: string, f: RankFilters & { sameRole?: boolean } = {}) {
  const { include } = matchFilter(f);
  const me = playerLeaderboard(0, include).find((x) => x.player.slug === slug);
  if (!me) return undefined;
  let field = playerLeaderboard(getSettings().playerRankMinMaps, include);
  if (f.sameRole) field = field.filter((x) => x.player.role === me.player.role);
  const pool = field.some((x) => x.player.slug === slug) ? field : [...field, me];
  return { me, pool, percentile: (f: (s: AggregatedStats) => number) => percentile(f(me), pool.map(f)) };
}

export function playerAttributes(slug: string, f: RankFilters & { sameRole?: boolean } = {}): Attribute[] | undefined {
  const cmp = comparison(slug, f);
  if (!cmp) return undefined;
  const { me, pool } = cmp;
  const totalWon = pool.reduce((n, x) => n + x.clutchesWon, 0);
  const totalPlayed = pool.reduce((n, x) => n + x.clutchesPlayed, 0);
  const prior = totalPlayed ? totalWon / totalPlayed : 0.3;
  const col = (f: (s: AggregatedStats) => number) => pool.map(f);
  const make = (key: string, label: string, source: string, raw: string, f: (s: AggregatedStats) => number): Attribute => ({
    key,
    label,
    source,
    raw,
    score: percentile(f(me), col(f)),
  });
  return [
    make("firepower", "Firepower", "ADR", me.adr.toFixed(1), (s) => s.adr),
    make("entrying", "Entrying", "K/D", me.kd.toFixed(2), (s) => s.kd),
    make("opening", "Opening", "RWS", me.rws.toFixed(2), (s) => s.rws),
    make("trading", "Trading", "KAST", `${me.kast.toFixed(1)}%`, (s) => s.kast),
    make(
      "clutching",
      "Clutching",
      "Clutch win %",
      me.clutchesPlayed ? `${Math.round((me.clutchesWon / me.clutchesPlayed) * 100)}% (${me.clutchesWon}/${me.clutchesPlayed})` : "—",
      (s) => clutchRate(s, prior),
    ),
    make("utility", "Utility", "Utility per round", utilityPerRound(me).toFixed(1), utilityPerRound),
  ];
}

/* ------------------------------ Achievements ------------------------------ */

export type Medal = "gold" | "silver" | "bronze";
export interface Achievement {
  event: EsportsEvent;
  place: string;
  medal: Medal | undefined;
  team?: string;
}

const medalFor = (place: string): Medal | undefined =>
  /^1/.test(place) ? "gold" : /^2/.test(place) ? "silver" : /^3/.test(place) ? "bronze" : undefined;

/** Placements a player earned (from the roster snapshot on each prize slot). */
export function playerAchievements(slug: string): Achievement[] {
  const out: Achievement[] = [];
  for (const e of getEvents()) {
    for (const slot of e.prizes) {
      if (slot.players?.includes(slug)) out.push({ event: e, place: slot.place, medal: medalFor(slot.place), team: slot.team });
    }
  }
  return out.sort((a, b) => b.event.endDate.localeCompare(a.event.endDate));
}

/** Placements of a team, newest first. */
export function teamAchievements(slug: string): Achievement[] {
  const out: Achievement[] = [];
  for (const e of getEvents()) {
    for (const slot of e.prizes) if (slot.team === slug) out.push({ event: e, place: slot.place, medal: medalFor(slot.place), team: slug });
  }
  return out.sort((a, b) => b.event.endDate.localeCompare(a.event.endDate));
}

export function playerAwards(slug: string) {
  const events = getEvents();
  const seasons = getSeasons().filter((s) => s.published);
  return {
    mvps: events.filter((e) => e.mvp === slug),
    evps: events.filter((e) => e.evps?.includes(slug)),
    seasonTops: seasons
      .map((s) => ({ season: s, rank: s.top.findIndex((t) => t.player === slug) + 1 }))
      .filter((x) => x.rank > 0),
  };
}

/* ------------------------------- Player rank ------------------------------ */

export type RankBoard = "overall" | "rating" | "elo" | "mvp" | "evp";

export interface RankFilters {
  season?: string;
  event?: string;
  team?: string;
  role?: string;
  minMaps?: number;
}

export interface RankRow {
  stats: AggregatedStats;
  mvps: number;
  evps: number;
  trophies: number;
  /** Overall score (see playerRank). */
  overall: number;
  /** Career player Elo (all matches, see src/data/elo.ts). */
  elo: number;
}

/**
 * Player rank, HLTV stats-page style.
 *   Rating:  round-weighted rating, highest first.
 *   Elo:     career player Elo (map results against the other lineup + form).
 *   MVP/EVP: number of event MVP / EVP awards, rating breaks ties.
 *   Overall: 0–100 = 55% rating percentile + 15% per MVP + 6% per EVP +
 *            8% per event win + 4% per 2nd place, capped at 100.
 * Filters narrow the matches counted (season dates, event) and the players
 * shown (team, role, minimum maps).
 */
export function playerRank(board: RankBoard, f: RankFilters = {}): RankRow[] {
  const { inRange, include } = matchFilter(f);
  const events = getEvents().filter((e) => (!f.event || e.slug === f.event) && inRange(e.endDate));

  const minMaps = f.minMaps ?? getSettings().playerRankMinMaps;
  let rows = playerLeaderboard(minMaps, include)
    .filter((s) => (!f.team || s.player.team === f.team) && (!f.role || rolesOf(s.player).includes(f.role as Role)))
    .map((stats) => {
      const slug = stats.player.slug;
      const mvps = events.filter((e) => e.mvp === slug).length;
      const evps = events.filter((e) => e.evps?.includes(slug)).length;
      const wins = events.filter((e) => e.prizes.some((p) => /^1/.test(p.place) && p.players?.includes(slug))).length;
      const seconds = events.filter((e) => e.prizes.some((p) => /^2/.test(p.place) && p.players?.includes(slug))).length;
      return { stats, mvps, evps, trophies: wins, seconds, overall: 0, elo: playerElo(slug)?.elo ?? eloSettings().start };
    });
  const ratings = rows.map((r) => r.stats.rating);
  rows = rows.map((r) => ({
    ...r,
    overall: Math.min(100, Math.round(percentile(r.stats.rating, ratings) * 0.55 + r.mvps * 15 + r.evps * 6 + r.trophies * 8 + r.seconds * 4)),
  }));
  const by = {
    overall: (a: RankRow, b: RankRow) => b.overall - a.overall || b.stats.rating - a.stats.rating,
    rating: (a: RankRow, b: RankRow) => b.stats.rating - a.stats.rating,
    elo: (a: RankRow, b: RankRow) => b.elo - a.elo || b.stats.rating - a.stats.rating,
    mvp: (a: RankRow, b: RankRow) => b.mvps - a.mvps || b.stats.rating - a.stats.rating,
    evp: (a: RankRow, b: RankRow) => b.evps - a.evps || b.stats.rating - a.stats.rating,
  }[board];
  return rows.sort(by);
}

/* --------------------------------- Search --------------------------------- */

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function search(query: string) {
  const q = fold(query.trim());
  if (!q) return { players: [] as Player[], teams: [] as Team[] };
  const score = (fields: string[]) => {
    const f = fields.map(fold);
    if (f.some((x) => x === q)) return 3;
    if (f.some((x) => x.startsWith(q))) return 2;
    if (f.some((x) => x.includes(q))) return 1;
    return 0;
  };
  const players = getPlayers()
    .map((p) => ({ p, s: score([p.nickname, p.firstName, p.lastName, `${p.firstName} ${p.lastName}`, p.ign ?? ""]) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.nickname.localeCompare(b.p.nickname))
    .map((x) => x.p);
  const teams = getTeams()
    .map((t) => ({ t, s: score([t.name, t.tag, t.slug]) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
    .map((x) => x.t);
  return { players, teams };
}

/** HLTV colours ratings: ≥ 1.10 good, < 0.95 poor (the number itself is the cue). */
export const ratingTone = (r: number) => (r >= 1.1 ? "good" : r < 0.95 ? "poor" : "even");

/* --------------------------------- Rails ---------------------------------- */

/**
 * "Player of the week": best round-weighted rating over the 7 days up to the
 * most recent completed match (min. 2 maps), like HLTV's award card.
 */
export function playerOfWeek() {
  const done = completedMatches();
  if (!done.length) return undefined;
  const last = matchDate(done[0]!);
  const from = last.subtract({ days: 6 });
  const inWeek = (m: Match) =>
    m.status === "completed" &&
    Temporal.PlainDate.compare(matchDate(m), from) >= 0 &&
    Temporal.PlainDate.compare(matchDate(m), last) <= 0;
  const best = playerLeaderboard(2, inWeek)[0];
  return best ? { stats: best, from, to: last } : undefined;
}

/** Money a player earned from placements (prize split across the 5-player roster snapshot). */
export function prizeMoney(slug: string) {
  return playerAchievements(slug).reduce((sum, a) => {
    const slot = a.event.prizes.find((p) => p.place === a.place && p.players?.includes(slug));
    return sum + (slot ? slot.prize / Math.max(1, slot.players!.length) : 0);
  }, 0);
}

/** A player's roles, primary first, without duplicates. */
export const rolesOf = (p: Pick<Player, "role" | "role2">): Role[] => (p.role2 && p.role2 !== p.role ? [p.role, p.role2] : [p.role]);
