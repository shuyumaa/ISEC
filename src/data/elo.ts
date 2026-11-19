import { Temporal } from "temporal-polyfill";
import { snapshot } from "../server/db";
import { event, getSettings, mapDecided, matchStart, player } from "./index";
import type { EloSettings, Match } from "./types";

/*
 * ISEC rating maths. Everything here is derived from completed matches, so it
 * is never typed in by hand (except the per-team adjustment) and always agrees
 * with the results on the site.
 *
 * TEAM ELO (one update per series)
 *   expected  E = 1 / (1 + 10^((R_opp − R_team) / 400))
 *   K         = k × tier weight × format weight × margin
 *               margin = 1 + marginStep × (maps won − maps lost − 1)
 *               (2–0 in a Bo3 counts more than 2–1; a Bo1 is always 1)
 *   change    Δ = round(K × (S − E)),  S = 1 for the winner, 0 for the loser
 *   The loser loses exactly what the winner gains (zero-sum).
 *   Ranking points = Elo + the admin's adjustment.
 *
 * PLAYER ELO (one update per map with stats)
 *   team part   playerK × tier weight × (S − E), E from the two lineups' average Elo
 *   form part   perf × (map rating − 1.00), capped at ±perf/2
 *   So winning against a stronger lineup lifts everyone, and a 1.40 rating
 *   lifts a player more than a 0.80 teammate in the same win.
 */

export const DEFAULT_ELO: EloSettings = {
  start: 1000,
  k: 40,
  playerK: 24,
  perf: 30,
  marginStep: 0.25,
  tier: { Major: 1.5, Premier: 1.25, Open: 1, Academy: 0.75 },
  format: { bo1: 0.8, bo3: 1, bo5: 1.2 },
  minMatches: 1,
};

export const expected = (r: number, opp: number) => 1 / (1 + 10 ** ((opp - r) / 400));

export interface EloChange {
  match: string;
  date: string;
  opponent: string;
  won: boolean;
  before: number;
  after: number;
  delta: number;
}

export interface TeamElo {
  team: string;
  elo: number;
  played: number;
  wins: number;
  losses: number;
  history: EloChange[];
}

export interface PlayerElo {
  player: string;
  elo: number;
  maps: number;
  peak: number;
  history: { match: string; map: string; date: string; delta: number; after: number }[];
}

interface Run {
  teams: Map<string, TeamElo>;
  players: Map<string, PlayerElo>;
}

function formatWeight(cfg: EloSettings, bo: Match["bestOf"]) {
  return bo === 1 ? cfg.format.bo1 : bo === 5 ? cfg.format.bo5 : cfg.format.bo3;
}

/** Elo for every team and player from completed matches that started before `until`. */
function compute(cfg: EloSettings, until?: Temporal.Instant): Run {
  const matches = snapshot()
    .matches.filter((m) => m.status === "completed" && m.seriesA !== m.seriesB)
    .map((m) => ({ m, at: matchStart(m) }))
    .filter((x) => !until || Temporal.Instant.compare(x.at.toInstant(), until) < 0)
    .sort((a, b) => Temporal.ZonedDateTime.compare(a.at, b.at));

  const teams = new Map<string, TeamElo>();
  const players = new Map<string, PlayerElo>();
  const t = (slug: string) => {
    let x = teams.get(slug);
    if (!x) teams.set(slug, (x = { team: slug, elo: cfg.start, played: 0, wins: 0, losses: 0, history: [] }));
    return x;
  };
  const p = (slug: string) => {
    let x = players.get(slug);
    if (!x) players.set(slug, (x = { player: slug, elo: cfg.start, maps: 0, peak: cfg.start, history: [] }));
    return x;
  };

  for (const { m, at } of matches) {
    const tier = cfg.tier[event(m.event).tier] ?? 1;
    const date = at.toPlainDate().toString();

    // Team update: whole series.
    const a = t(m.teamA);
    const b = t(m.teamB);
    const sA = m.seriesA > m.seriesB ? 1 : 0;
    const margin = 1 + cfg.marginStep * (Math.abs(m.seriesA - m.seriesB) - 1);
    const k = cfg.k * tier * formatWeight(cfg, m.bestOf) * margin;
    const delta = Math.round(k * (sA - expected(a.elo, b.elo)));
    for (const [side, opp, d, won] of [
      [a, b, delta, sA === 1],
      [b, a, -delta, sA === 0],
    ] as const) {
      side.history.push({ match: m.id, date, opponent: opp.team, won, before: side.elo, after: side.elo + d, delta: d });
      side.elo += d;
      side.played += 1;
      if (won) side.wins += 1;
      else side.losses += 1;
    }

    // Player update: each decided map that has stats.
    for (const map of m.maps) {
      if (!map.stats?.length || !mapDecided(map)) continue;
      const lineA = map.stats.filter((s) => player(s.player).team === m.teamA);
      const lineB = map.stats.filter((s) => player(s.player).team === m.teamB);
      if (!lineA.length || !lineB.length) continue;
      const avg = (line: typeof lineA) => line.reduce((n, s) => n + p(s.player).elo, 0) / line.length;
      const eloA = avg(lineA);
      const eloB = avg(lineB);
      const mapWonA = map.scoreA! > map.scoreB! ? 1 : 0;
      const cap = cfg.perf / 2;
      const deltas = [
        ...lineA.map((s) => [s, mapWonA - expected(eloA, eloB)] as const),
        ...lineB.map((s) => [s, 1 - mapWonA - expected(eloB, eloA)] as const),
      ].map(([s, team]) => {
        const form = Math.max(-cap, Math.min(cap, cfg.perf * (s.rating - 1)));
        return [s.player, Math.round(cfg.playerK * tier * team + form)] as const;
      });
      // Apply after computing all deltas so lineup averages use pre-map values.
      for (const [slug, d] of deltas) {
        const x = p(slug);
        x.elo += d;
        x.maps += 1;
        x.peak = Math.max(x.peak, x.elo);
        x.history.push({ match: m.id, map: map.map, date, delta: d, after: x.elo });
      }
    }
  }
  return { teams, players };
}

/* ------------------------------- Public API ------------------------------- */

const cache = new WeakMap<object, { now: Run; weekAgo: Run }>();

function runs() {
  const s = snapshot();
  let r = cache.get(s);
  if (!r) {
    const cfg = eloSettings();
    const weekAgo = Temporal.Now.instant().subtract({ hours: 24 * 7 });
    r = { now: compute(cfg), weekAgo: compute(cfg, weekAgo) };
    cache.set(s, r);
  }
  return r;
}

export const eloSettings = (): EloSettings => {
  const saved = getSettings().elo;
  return { ...DEFAULT_ELO, ...saved, tier: { ...DEFAULT_ELO.tier, ...saved?.tier }, format: { ...DEFAULT_ELO.format, ...saved?.format } };
};

export interface RankRowTeam extends TeamElo {
  points: number;
  adjust: number;
  /** Positions gained since 7 days ago (0 when new). */
  change: number;
  isNew: boolean;
}

function ranked(run: Run): RankRowTeam[] {
  const cfg = eloSettings();
  const adjust = new Map(snapshot().ranking.map((r) => [r.team, r.adjust ?? 0]));
  const known = new Set(snapshot().teams.map((x) => x.slug));
  return [...run.teams.values()]
    .filter((x) => known.has(x.team) && x.played >= cfg.minMatches)
    .map((x) => ({ ...x, adjust: adjust.get(x.team) ?? 0, points: x.elo + (adjust.get(x.team) ?? 0), change: 0, isNew: false }))
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.team.localeCompare(b.team));
}

const tableCache = new WeakMap<object, RankRowTeam[]>();

/** The team ranking: Elo + adjustment, highest first, with weekly movement. */
export function teamTable(): RankRowTeam[] {
  const s = snapshot();
  let rows = tableCache.get(s);
  if (!rows) {
    const { now, weekAgo } = runs();
    const before = new Map(ranked(weekAgo).map((r, i) => [r.team, i + 1]));
    rows = ranked(now).map((r, i) => {
      const prev = before.get(r.team);
      return { ...r, change: prev ? prev - (i + 1) : 0, isNew: !prev };
    });
    tableCache.set(s, rows);
  }
  return rows;
}

export const teamElo = (slug: string) => runs().now.teams.get(slug);
export const playerElo = (slug: string) => runs().now.players.get(slug);

/** Every player with at least one rated map, highest Elo first. */
export const playerEloTable = () => [...runs().now.players.values()].sort((a, b) => b.elo - a.elo);

/** Date of the latest completed match counted (the ranking's "as of"). */
export function rankingAsOf(): string {
  let last = "";
  for (const x of runs().now.teams.values()) for (const h of x.history) if (h.date > last) last = h.date;
  return last;
}
