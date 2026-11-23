import { matchesForEvent, winnerOf } from "./index";
import type { EsportsEvent, Match } from "./types";

/*
 * Bracket diagrams, derived from an event's matches (nothing is stored).
 *
 * SWISS: matches whose stage starts with the event's swiss.stage prefix, in
 * start order. Each match is placed by the record its teams had going in
 * (0:0, 1:0, 0:1 …). A team that reaches `wins` advances and one that reaches
 * `losses` is out. Slots that are not scheduled yet are counted from the field
 * size so the diagram has its final shape from day one:
 *   teams on record w:l after r = w + l rounds = N × C(r, w) / 2^r
 * (only records still in play continue; finished teams leave the pool).
 */

export interface SwissSlot {
  match?: Match;
}
export interface SwissBucket {
  wins: number;
  losses: number;
  slots: SwissSlot[];
}
export interface SwissColumn {
  round: number;
  buckets: SwissBucket[];
}
export interface SwissOutcome {
  wins: number;
  losses: number;
  teams: (string | undefined)[];
}
export interface Swiss {
  columns: SwissColumn[];
  advanced: SwissOutcome[];
  eliminated: SwissOutcome[];
  size: number;
  rules: NonNullable<EsportsEvent["swiss"]>;
}

/** Expected teams on a record, counting only paths that never hit a limit before. */
function expectedTeams(n: number, w: number, l: number, W: number, L: number) {
  // Paths to (w, l) staying inside w < W and l < L until the last step: dynamic programming.
  const ways: number[][] = Array.from({ length: W + 1 }, () => Array(L + 1).fill(0));
  ways[0]![0] = 1;
  for (let a = 0; a <= W; a++)
    for (let b = 0; b <= L; b++) {
      if (a === 0 && b === 0) continue;
      const fromWin = a > 0 && a - 1 < W && b < L ? ways[a - 1]![b]! : 0;
      const fromLoss = b > 0 && b - 1 < L && a < W ? ways[a]![b - 1]! : 0;
      ways[a]![b] = fromWin + fromLoss;
    }
  return (n * ways[w]![l]!) / 2 ** (w + l);
}

export function swissBracket(ev: EsportsEvent): Swiss | undefined {
  const rules = ev.swiss;
  if (!rules) return undefined;
  const prefix = rules.stage.toLowerCase();
  const matches = matchesForEvent(ev.slug).filter((m) => m.stage.toLowerCase().startsWith(prefix));
  if (!matches.length) return undefined;

  const teams = new Set(matches.flatMap((m) => [m.teamA, m.teamB]));
  const size = Math.max(teams.size, 2);
  const record = new Map<string, { w: number; l: number }>([...teams].map((t) => [t, { w: 0, l: 0 }]));
  const placed = new Map<string, Match[]>();

  for (const m of matches) {
    const ra = record.get(m.teamA)!;
    const key = `${ra.w}:${ra.l}`;
    if (!placed.has(key)) placed.set(key, []);
    placed.get(key)!.push(m);
    const winner = winnerOf(m);
    if (winner) {
      const loser = winner === m.teamA ? m.teamB : m.teamA;
      record.get(winner)!.w += 1;
      record.get(loser)!.l += 1;
    }
  }

  const { wins: W, losses: L } = rules;
  const columns: SwissColumn[] = [];
  for (let round = 0; round <= W + L - 2; round++) {
    const buckets: SwissBucket[] = [];
    for (let w = Math.min(round, W - 1); w >= 0; w--) {
      const l = round - w;
      if (l >= L) continue;
      const expected = Math.round(expectedTeams(size, w, l, W, L) / 2);
      const got = placed.get(`${w}:${l}`) ?? [];
      const count = Math.max(expected, got.length);
      if (!count) continue;
      buckets.push({ wins: w, losses: l, slots: Array.from({ length: count }, (_, i) => ({ match: got[i] })) });
    }
    if (buckets.length) columns.push({ round, buckets });
  }

  const finished = (w: number, l: number) => [...record].filter(([, r]) => r.w === w && r.l === l).map(([t]) => t);
  const outcome = (w: number, l: number): SwissOutcome => {
    const got = finished(w, l);
    const expected = Math.round(expectedTeams(size, w, l, W, L));
    return { wins: w, losses: l, teams: Array.from({ length: Math.max(expected, got.length) }, (_, i) => got[i]) };
  };
  return {
    columns,
    advanced: Array.from({ length: L }, (_, k) => outcome(W, k)).filter((o) => o.teams.length),
    eliminated: Array.from({ length: W }, (_, k) => outcome(k, L)).filter((o) => o.teams.length),
    size,
    rules,
  };
}

/* ------------------------------- Playoffs -------------------------------- */

const ROUNDS: [RegExp, string][] = [
  [/round of 16|r16|eighth/i, "Round of 16"],
  [/quarter/i, "Quarter-finals"],
  [/semi/i, "Semi-finals"],
  [/3rd|third/i, "Third place"],
  [/final/i, "Grand final"],
];

export interface PlayoffRound {
  name: string;
  matches: Match[];
}

/** Playoff columns: quarter-finals → semi-finals → final, from stage names. */
export function playoffBracket(ev: EsportsEvent): PlayoffRound[] {
  const swissPrefix = ev.swiss?.stage.toLowerCase();
  const rounds = new Map<number, PlayoffRound>();
  for (const m of matchesForEvent(ev.slug)) {
    if (swissPrefix && m.stage.toLowerCase().startsWith(swissPrefix)) continue;
    // "Lower bracket final" and other double-elimination stages are left to the match list.
    if (/lower|upper|group/i.test(m.stage)) continue;
    const i = ROUNDS.findIndex(([re]) => re.test(m.stage));
    if (i < 0) continue;
    if (!rounds.has(i)) rounds.set(i, { name: ROUNDS[i]![1], matches: [] });
    rounds.get(i)!.matches.push(m);
  }
  return [...rounds].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}
