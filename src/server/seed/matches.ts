import { players } from "./teams";
import type { MapName, MapResult, Match, MatchStatus, PlayerMapStats, Side, VetoStep } from "../../data/types";

/* ------------------------------------------------------------------------- *
 * Deterministic mock generator.
 * Fixtures below only state who played whom, when, and the series score.
 * Maps, veto, round scores and player stats are derived from a seeded RNG,
 * so every build renders identical data. Replace `matches` with API data.
 * ------------------------------------------------------------------------- */

const MAP_POOL: MapName[] = ["Mirage", "Inferno", "Nuke", "Ancient", "Anubis", "Dust2", "Train"];

function hash(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function rng(seed: string) {
  let a = hash(seed);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: () => number, min: number, max: number) => min + r() * (max - min);
const int = (r: () => number, min: number, max: number) => Math.floor(between(r, min, max + 1));
const round = (n: number, d = 0) => Number(n.toFixed(d));

function shuffle<T>(items: T[], r: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Final round score for a map won by `aWins`. MR12, overtime MR3. */
function mapScore(r: () => number, aWins: boolean): [number, number] {
  const ot = r() < 0.12;
  const loser = ot ? 14 + 3 * int(r, 0, 1) : int(r, 2, 11);
  const winner = ot ? loser + 2 : 13;
  return aWins ? [winner, loser] : [loser, winner];
}

function halves(r: () => number, a: number, b: number): { halfA: [number, number]; halfB: [number, number] } {
  const total = a + b;
  if (total <= 12) return { halfA: [a, 0], halfB: [b, 0] };
  const lo = Math.max(0, 12 - b);
  const hi = Math.min(12, a);
  const firstA = int(r, lo, hi);
  const firstB = 12 - firstA;
  return { halfA: [firstA, a - firstA], halfB: [firstB, b - firstB] };
}

function playerStats(r: () => number, team: string, rounds: number, won: boolean): PlayerMapStats[] {
  return players
    .filter((p) => p.team === team)
    .map((p) => {
      const star = p.role === "AWP" || p.role === "Entry" ? 0.06 : 0;
      const kpr = between(r, won ? 0.62 : 0.5, won ? 0.92 : 0.78) + star;
      const dpr = between(r, won ? 0.5 : 0.62, won ? 0.68 : 0.8);
      const kills = Math.max(0, round(rounds * kpr));
      const deaths = Math.max(1, round(rounds * dpr));
      const adr = round(kpr * 118 + between(r, -10, 10), 1);
      const kast = round(between(r, won ? 68 : 58, won ? 84 : 74), 1);
      const rating = round((kpr / 0.68) * 0.45 + ((1 - dpr) / 0.32) * 0.25 + (adr / 76) * 0.3, 2);
      return {
        player: p.slug,
        kills,
        deaths,
        assists: round(rounds * between(r, 0.08, 0.24)),
        adr,
        kast,
        hs: round(between(r, 32, 62), 1),
        rating,
      };
    });
}

/** Sequence of map winners (true = team A) that ends exactly at the series score. */
function mapWinners(r: () => number, sa: number, sb: number): boolean[] {
  const total = sa + sb;
  const winnerA = sa > sb;
  // The final map always goes to the series winner; shuffle the rest.
  const rest = [
    ...Array<boolean>(winnerA ? sa - 1 : sa).fill(true),
    ...Array<boolean>(winnerA ? sb : sb - 1).fill(false),
  ];
  return total === 0 ? [] : [...shuffle(rest, r), winnerA];
}

function buildVeto(r: () => number, bestOf: 1 | 3 | 5, a: string, b: string): { veto: VetoStep[]; picks: { map: MapName; by?: string }[] } {
  const pool = shuffle(MAP_POOL, r);
  const veto: VetoStep[] = [];
  const picks: { map: MapName; by?: string }[] = [];
  const take = () => pool.shift()!;
  const order =
    bestOf === 1
      ? ["rA", "rB", "rA", "rB", "rA", "rB"]
      : bestOf === 3
        ? ["rA", "rB", "pA", "pB", "rA", "rB"]
        : ["rA", "rB", "pA", "pB", "pA", "pB"];
  for (const step of order) {
    const team = step.endsWith("A") ? a : b;
    const map = take();
    if (step.startsWith("p")) {
      veto.push({ team, action: "picked", map });
      picks.push({ map, by: team });
    } else {
      veto.push({ team, action: "removed", map });
    }
  }
  const decider = take();
  veto.push({ action: "left over", map: decider });
  picks.push({ map: decider });
  return { veto, picks };
}

interface Fixture {
  id: string;
  event: string;
  stage: string;
  bestOf: 1 | 3 | 5;
  start: string;
  a: string;
  b: string;
  /** Final series score; omit for upcoming. */
  result?: [number, number];
  /** For live matches: maps already finished and the running score on the current map. */
  live?: { series: [number, number]; current: [number, number] };
  stars?: 0 | 1 | 2 | 3;
}

function build(f: Fixture): Match {
  const r = rng(f.id);
  const { veto, picks } = buildVeto(r, f.bestOf, f.a, f.b);
  const status: MatchStatus = f.live ? "live" : f.result ? "completed" : "upcoming";

  let winners: boolean[] = [];
  if (f.result) {
    winners = mapWinners(r, f.result[0], f.result[1]);
  } else if (f.live) {
    // A running series has no "deciding" map yet, so any order of finished maps is valid.
    const [la, lb] = f.live.series;
    winners = shuffle([...Array<boolean>(la).fill(true), ...Array<boolean>(lb).fill(false)], r);
  }

  const maps: MapResult[] = picks.map(({ map, by }, i) => {
    const base: MapResult = { map, pickedBy: by };
    const startSideA: Side = r() < 0.5 ? "CT" : "T";
    if (i < winners.length) {
      const aWins = winners[i]!;
      const [scoreA, scoreB] = mapScore(r, aWins);
      return {
        ...base,
        scoreA,
        scoreB,
        startSideA,
        ...halves(r, scoreA, scoreB),
        stats: [
          ...playerStats(r, f.a, scoreA + scoreB, aWins),
          ...playerStats(r, f.b, scoreA + scoreB, !aWins),
        ],
      };
    }
    if (f.live && i === winners.length) {
      const [scoreA, scoreB] = f.live.current;
      return {
        ...base,
        scoreA,
        scoreB,
        startSideA,
        ...halves(r, scoreA, scoreB),
        live: true,
        stats: [
          ...playerStats(r, f.a, Math.max(1, scoreA + scoreB), scoreA >= scoreB),
          ...playerStats(r, f.b, Math.max(1, scoreA + scoreB), scoreB > scoreA),
        ],
      };
    }
    return base;
  });

  return {
    id: f.id,
    event: f.event,
    stage: f.stage,
    bestOf: f.bestOf,
    status,
    start: f.start,
    teamA: f.a,
    teamB: f.b,
    seriesA: f.result?.[0] ?? f.live?.series[0] ?? 0,
    seriesB: f.result?.[1] ?? f.live?.series[1] ?? 0,
    maps: f.bestOf === 1 ? maps.slice(-1) : maps,
    veto,
    stars: f.stars ?? 0,
  };
}

const fixtures: Fixture[] = [
  // — ISEC Winter Open 2026 (Berlin) —
  { id: "2380101", event: "winter-open-2026", stage: "Group A — Opening", bestOf: 3, start: "2026-11-16T13:00", a: "northwind", b: "iron-lotus", result: [2, 0], stars: 1 },
  { id: "2380102", event: "winter-open-2026", stage: "Group A — Opening", bestOf: 3, start: "2026-11-16T16:00", a: "vanta", b: "kairos", result: [2, 1], stars: 1 },
  { id: "2380103", event: "winter-open-2026", stage: "Group B — Opening", bestOf: 3, start: "2026-11-16T19:00", a: "monolith", b: "parallax", result: [2, 0], stars: 1 },
  { id: "2380104", event: "winter-open-2026", stage: "Group B — Opening", bestOf: 3, start: "2026-11-16T22:00", a: "obsidian", b: "halcyon", result: [2, 1] },
  { id: "2380105", event: "winter-open-2026", stage: "Group A — Winners", bestOf: 3, start: "2026-11-17T13:00", a: "northwind", b: "vanta", result: [2, 1], stars: 2 },
  { id: "2380106", event: "winter-open-2026", stage: "Group A — Elimination", bestOf: 3, start: "2026-11-17T16:00", a: "kairos", b: "iron-lotus", result: [2, 0] },
  { id: "2380107", event: "winter-open-2026", stage: "Group B — Winners", bestOf: 3, start: "2026-11-17T19:00", a: "monolith", b: "obsidian", result: [2, 0], stars: 2 },
  { id: "2380108", event: "winter-open-2026", stage: "Group B — Elimination", bestOf: 3, start: "2026-11-17T22:00", a: "halcyon", b: "parallax", result: [2, 1] },
  { id: "2380109", event: "winter-open-2026", stage: "Group A — Decider", bestOf: 3, start: "2026-11-18T15:00", a: "vanta", b: "kairos", result: [2, 1], stars: 2 },
  { id: "2380110", event: "winter-open-2026", stage: "Group B — Decider", bestOf: 3, start: "2026-11-18T18:30", a: "obsidian", b: "halcyon", result: [2, 0], stars: 1 },
  { id: "2380111", event: "winter-open-2026", stage: "Semi-final 1", bestOf: 3, start: "2026-11-19T15:00", a: "northwind", b: "obsidian", live: { series: [1, 0], current: [8, 6] }, stars: 3 },
  { id: "2380112", event: "winter-open-2026", stage: "Semi-final 2", bestOf: 3, start: "2026-11-19T19:00", a: "monolith", b: "vanta", stars: 3 },

  // — ISEC Academy League Season 2 (online) —
  { id: "2380201", event: "academy-league-s2", stage: "Round 1", bestOf: 1, start: "2026-11-05T18:00", a: "zenith", b: "arc-seven", result: [1, 0] },
  { id: "2380202", event: "academy-league-s2", stage: "Round 1", bestOf: 1, start: "2026-11-05T19:30", a: "lumen", b: "granite", result: [0, 1] },
  { id: "2380203", event: "academy-league-s2", stage: "Round 1", bestOf: 1, start: "2026-11-05T21:00", a: "quietus", b: "helix", result: [1, 0] },
  { id: "2380204", event: "academy-league-s2", stage: "Round 2", bestOf: 1, start: "2026-11-10T18:00", a: "zenith", b: "granite", result: [1, 0] },
  { id: "2380205", event: "academy-league-s2", stage: "Round 2", bestOf: 1, start: "2026-11-10T19:30", a: "arc-seven", b: "helix", result: [1, 0] },
  { id: "2380206", event: "academy-league-s2", stage: "Round 2", bestOf: 1, start: "2026-11-10T21:00", a: "lumen", b: "quietus", result: [1, 0] },
  { id: "2380207", event: "academy-league-s2", stage: "Round 3", bestOf: 1, start: "2026-11-15T18:00", a: "zenith", b: "helix", result: [0, 1] },
  { id: "2380208", event: "academy-league-s2", stage: "Round 3", bestOf: 1, start: "2026-11-15T19:30", a: "granite", b: "quietus", result: [1, 0] },
  { id: "2380209", event: "academy-league-s2", stage: "Round 3", bestOf: 1, start: "2026-11-15T21:00", a: "arc-seven", b: "lumen", result: [1, 0] },
  { id: "2380210", event: "academy-league-s2", stage: "Round 4", bestOf: 1, start: "2026-11-19T13:30", a: "zenith", b: "quietus", live: { series: [0, 0], current: [10, 11] }, stars: 1 },
  { id: "2380211", event: "academy-league-s2", stage: "Round 4", bestOf: 1, start: "2026-11-19T20:00", a: "helix", b: "lumen" },
  { id: "2380212", event: "academy-league-s2", stage: "Round 4", bestOf: 1, start: "2026-11-19T21:30", a: "granite", b: "arc-seven", stars: 1 },
  { id: "2380213", event: "academy-league-s2", stage: "Round 5", bestOf: 1, start: "2026-11-24T18:00", a: "zenith", b: "lumen" },
  { id: "2380214", event: "academy-league-s2", stage: "Round 5", bestOf: 1, start: "2026-11-24T19:30", a: "quietus", b: "arc-seven" },
  { id: "2380215", event: "academy-league-s2", stage: "Round 5", bestOf: 1, start: "2026-11-24T21:00", a: "helix", b: "granite" },

  // — ISEC Masters Season 3 (Stockholm) — Swiss round 1
  { id: "2380301", event: "masters-s3", stage: "Swiss — Round 1", bestOf: 1, start: "2026-12-03T11:00", a: "northwind", b: "lumen", stars: 2 },
  { id: "2380302", event: "masters-s3", stage: "Swiss — Round 1", bestOf: 1, start: "2026-12-03T12:15", a: "monolith", b: "quietus", stars: 2 },
  { id: "2380303", event: "masters-s3", stage: "Swiss — Round 1", bestOf: 1, start: "2026-12-03T13:30", a: "vanta", b: "helix", stars: 2 },
  { id: "2380304", event: "masters-s3", stage: "Swiss — Round 1", bestOf: 1, start: "2026-12-03T14:45", a: "iron-lotus", b: "zenith", stars: 1 },
  { id: "2380305", event: "masters-s3", stage: "Swiss — Round 1", bestOf: 1, start: "2026-12-03T16:00", a: "nocturne", b: "granite", stars: 1 },
  { id: "2380306", event: "masters-s3", stage: "Swiss — Round 1", bestOf: 1, start: "2026-12-03T17:15", a: "obsidian", b: "arc-seven", stars: 1 },
  { id: "2380307", event: "masters-s3", stage: "Swiss — Round 1", bestOf: 1, start: "2026-12-03T18:30", a: "kairos", b: "halcyon", stars: 1 },
  { id: "2380308", event: "masters-s3", stage: "Swiss — Round 1", bestOf: 1, start: "2026-12-03T19:45", a: "parallax", b: "static-five", stars: 1 },

  // — ISEC Autumn Cup 2026 (online) —
  { id: "2370401", event: "autumn-cup-2026", stage: "Quarter-final", bestOf: 3, start: "2026-10-20T17:00", a: "nocturne", b: "lumen", result: [2, 0] },
  { id: "2370402", event: "autumn-cup-2026", stage: "Quarter-final", bestOf: 3, start: "2026-10-20T20:00", a: "granite", b: "helix", result: [2, 1] },
  { id: "2370403", event: "autumn-cup-2026", stage: "Quarter-final", bestOf: 3, start: "2026-10-21T17:00", a: "static-five", b: "quietus", result: [2, 0] },
  { id: "2370404", event: "autumn-cup-2026", stage: "Quarter-final", bestOf: 3, start: "2026-10-21T20:00", a: "zenith", b: "arc-seven", result: [2, 1] },
  { id: "2370405", event: "autumn-cup-2026", stage: "Semi-final", bestOf: 3, start: "2026-10-23T17:00", a: "nocturne", b: "granite", result: [2, 1], stars: 1 },
  { id: "2370406", event: "autumn-cup-2026", stage: "Semi-final", bestOf: 3, start: "2026-10-23T20:00", a: "static-five", b: "zenith", result: [2, 0], stars: 1 },
  { id: "2370407", event: "autumn-cup-2026", stage: "Grand final", bestOf: 5, start: "2026-10-25T18:00", a: "nocturne", b: "static-five", result: [3, 2], stars: 3 },

  // — ISEC Pacific Invitational 2026 (Sydney) —
  { id: "2360501", event: "pacific-invitational-2026", stage: "Lower bracket final", bestOf: 3, start: "2026-09-12T15:00", a: "arc-seven", b: "static-five", result: [2, 1], stars: 2 },
  { id: "2360502", event: "pacific-invitational-2026", stage: "Grand final", bestOf: 5, start: "2026-09-13T16:00", a: "iron-lotus", b: "arc-seven", result: [3, 1], stars: 3 },
];

export const matches: Match[] = fixtures.map(build);
