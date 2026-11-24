import type { EsportsEvent, Match } from "./types";

/*
 * "Two groups + playoffs" format:
 *   Group stage: groups A and B, 8 teams each, double elimination.
 *     Upper bracket: 4 quarter-finals → 2 semi-finals → final.
 *     Lower bracket: round 1 (losers of the upper quarter-finals) → round 2
 *     (round-1 winners vs losers of the upper semi-finals, crossed so the same
 *     teams don't meet again) → lower final.
 *     Upper final winner = 1st, upper final loser = 2nd, lower final winner = 3rd.
 *   Playoffs: single elimination. QF1 A2–B3, QF2 B2–A3, SF1 B1–winner QF1,
 *     SF2 A1–winner QF2, Grand final.
 *
 * Every match of the format has a fixed `slot` (e.g. "A:UQF1", "PO:GF"). The
 * routes below say where a slot's winner and loser go, so results flow into
 * the next matches by themselves, and empty sides can say what they wait for.
 */

export type BracketSide = "A" | "B";
interface SlotDef {
  slot: string;
  /** Stage name shown everywhere else (match lists, match page). */
  stage: string;
  /** Short label inside the diagram. */
  short: string;
  part: "upper" | "lower" | "playoffs";
  column: number;
  kind: "group" | "qf" | "sf" | "gf";
  winner?: [string, BracketSide];
  loser?: [string, BracketSide];
}

const groupSlots = (g: string): SlotDef[] => {
  const s = (x: string) => `${g}:${x}`;
  const stage = (x: string) => `Group ${g} · ${x}`;
  const out: SlotDef[] = [];
  // Upper quarter-finals: winners pair up in the semis, losers drop to lower round 1.
  for (let i = 1; i <= 4; i++)
    out.push({
      slot: s(`UQF${i}`),
      stage: stage(`Upper quarter-final ${i}`),
      short: `Upper QF ${i}`,
      part: "upper",
      column: 0,
      kind: "group",
      winner: [s(`USF${Math.ceil(i / 2)}`), i % 2 ? "A" : "B"],
      loser: [s(`LR1-${Math.ceil(i / 2)}`), i % 2 ? "A" : "B"],
    });
  // Upper semis: losers cross over in lower round 2 (USF1 loser meets the LR1-2 winner).
  out.push({ slot: s("USF1"), stage: stage("Upper semi-final 1"), short: "Upper SF 1", part: "upper", column: 1, kind: "group", winner: [s("UF"), "A"], loser: [s("LR2-1"), "A"] });
  out.push({ slot: s("USF2"), stage: stage("Upper semi-final 2"), short: "Upper SF 2", part: "upper", column: 1, kind: "group", winner: [s("UF"), "B"], loser: [s("LR2-2"), "A"] });
  out.push({ slot: s("UF"), stage: stage("Upper final"), short: "Upper final", part: "upper", column: 2, kind: "group" });
  out.push({ slot: s("LR1-1"), stage: stage("Lower round 1 · Match 1"), short: "Lower R1 · 1", part: "lower", column: 0, kind: "group", winner: [s("LR2-2"), "B"] });
  out.push({ slot: s("LR1-2"), stage: stage("Lower round 1 · Match 2"), short: "Lower R1 · 2", part: "lower", column: 0, kind: "group", winner: [s("LR2-1"), "B"] });
  out.push({ slot: s("LR2-1"), stage: stage("Lower round 2 · Match 1"), short: "Lower R2 · 1", part: "lower", column: 1, kind: "group", winner: [s("LF"), "A"] });
  out.push({ slot: s("LR2-2"), stage: stage("Lower round 2 · Match 2"), short: "Lower R2 · 2", part: "lower", column: 1, kind: "group", winner: [s("LF"), "B"] });
  out.push({ slot: s("LF"), stage: stage("Lower final"), short: "Lower final", part: "lower", column: 2, kind: "group" });
  return out;
};

const PLAYOFFS: SlotDef[] = [
  { slot: "PO:QF1", stage: "Playoffs · Quarter-final 1", short: "Quarter-final 1", part: "playoffs", column: 0, kind: "qf", winner: ["PO:SF1", "B"] },
  { slot: "PO:QF2", stage: "Playoffs · Quarter-final 2", short: "Quarter-final 2", part: "playoffs", column: 0, kind: "qf", winner: ["PO:SF2", "B"] },
  { slot: "PO:SF1", stage: "Playoffs · Semi-final 1", short: "Semi-final 1", part: "playoffs", column: 1, kind: "sf", winner: ["PO:GF", "A"] },
  { slot: "PO:SF2", stage: "Playoffs · Semi-final 2", short: "Semi-final 2", part: "playoffs", column: 1, kind: "sf", winner: ["PO:GF", "B"] },
  { slot: "PO:GF", stage: "Grand final", short: "Grand final", part: "playoffs", column: 2, kind: "gf" },
];

export const GROUPS = ["A", "B"] as const;

/** Group results into the playoffs (1st straight to the semis, 2nd/3rd to the quarters). */
const PLACEMENT: Record<string, { winner?: [string, BracketSide]; loser?: [string, BracketSide] }> = {
  "A:UF": { winner: ["PO:SF2", "A"], loser: ["PO:QF1", "A"] },
  "B:UF": { winner: ["PO:SF1", "A"], loser: ["PO:QF2", "A"] },
  "A:LF": { winner: ["PO:QF2", "B"] },
  "B:LF": { winner: ["PO:QF1", "B"] },
};

export const SLOTS: SlotDef[] = [...GROUPS.flatMap(groupSlots), ...PLAYOFFS].map((d) => ({ ...d, ...PLACEMENT[d.slot] }));
const BY_SLOT = new Map(SLOTS.map((d) => [d.slot, d]));
export const slotDef = (slot: string) => BY_SLOT.get(slot);

/** Order matches are played in (round by round, A and B interleaved, Grand final last). */
export const PLAY_ORDER = [
  ...[1, 2, 3, 4].flatMap((i) => GROUPS.map((g) => `${g}:UQF${i}`)),
  ...[1, 2].flatMap((i) => GROUPS.map((g) => `${g}:LR1-${i}`)),
  ...[1, 2].flatMap((i) => GROUPS.map((g) => `${g}:USF${i}`)),
  ...[1, 2].flatMap((i) => GROUPS.map((g) => `${g}:LR2-${i}`)),
  ...GROUPS.map((g) => `${g}:UF`),
  ...GROUPS.map((g) => `${g}:LF`),
  "PO:QF1",
  "PO:QF2",
  "PO:SF1",
  "PO:SF2",
  "PO:GF",
];

/**
 * Which slot(s) a free-typed stage name means, e.g. "Group A Upper QF 2" →
 * ["A:UQF2"], "Semi-final" → ["PO:SF1", "PO:SF2"], "Grand Final" → ["PO:GF"].
 * Used to link matches that were scheduled by hand before the bracket existed.
 */
export function slotsForStage(stage: string): string[] {
  let t = ` ${stage.toLowerCase().normalize("NFKD")} `
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bquarter ?finals?\b|\bquarters\b/g, " qf ")
    .replace(/\bsemi ?finals?\b|\bsemis\b/g, " sf ")
    .replace(/\bgrand ?finals?\b/g, " gf ")
    .replace(/\bu(qf|sf)(\d?)\b/g, " upper $1 $2 ")
    .replace(/\buf\b/g, " upper final ")
    .replace(/\blf\b/g, " lower final ")
    .replace(/\blr ?(\d) ?(\d?)\b/g, " lower round $1 match $2 ")
    .replace(/\b(qf|sf)(\d)\b/g, " $1 $2 ");
  const group = /\bgroup ([ab])\b|\b([ab]) group\b/.exec(t);
  const g = (group?.[1] ?? group?.[2])?.toUpperCase();
  const lower = /\b(lower|lb|losers?|elimination)\b/.test(t);
  const round = /\b(?:round|r) ?(\d)\b/.exec(t)?.[1];
  if (round) t = t.replace(/\b(?:round|r) ?\d\b/, " ");
  if (group) t = t.replace(group[0], " ");
  const n = /\b(\d)\b/.exec(t)?.[1];
  const kind = /\bgf\b/.test(t) ? "gf" : /\bqf\b/.test(t) ? "qf" : /\bsf\b/.test(t) ? "sf" : /\bfinal\b/.test(t) ? "final" : undefined;
  const pick = (base: string, count: number) => (n ? (Number(n) >= 1 && Number(n) <= count ? [`${base}${n}`] : []) : Array.from({ length: count }, (_, i) => `${base}${i + 1}`));
  if (!g) {
    if (kind === "gf" || (kind === "final" && !lower && !/\bupper\b/.test(t))) return ["PO:GF"];
    if (kind === "qf") return pick("PO:QF", 2);
    if (kind === "sf") return pick("PO:SF", 2);
    return [];
  }
  if (lower) {
    if (kind === "final") return [`${g}:LF`];
    if (round === "1" || round === "2") return pick(`${g}:LR${round}-`, 2);
    return [];
  }
  if (kind === "qf") return pick(`${g}:UQF`, 4);
  if (kind === "sf") return pick(`${g}:USF`, 2);
  if (kind === "final") return [`${g}:UF`];
  return [];
}

/**
 * Pair an event's matches that have no slot yet with free slots: first by the
 * seeded teams of a first-round match, then by stage name (earliest first).
 */
export function linkExisting(matches: Match[], taken: Set<string>, seeds = new Map<string, string>()): Map<string, Match> {
  const out = new Map<string, Match>();
  const free = (slot: string) => !taken.has(slot) && !out.has(slot);
  const pool = matches.filter((m) => !m.slot).toSorted((a, b) => a.start.localeCompare(b.start) || Number(a.id) - Number(b.id));
  const used = new Set<string>();
  for (const slot of PLAY_ORDER) {
    const a = seeds.get(`${slot}:A`);
    const b = seeds.get(`${slot}:B`);
    if (!a || !b || !free(slot)) continue;
    const m = pool.find((x) => !used.has(x.id) && ((x.teamA === a && x.teamB === b) || (x.teamA === b && x.teamB === a)));
    if (m) (out.set(slot, m), used.add(m.id));
  }
  for (const m of pool) {
    if (used.has(m.id)) continue;
    const slot = slotsForStage(m.stage).find(free);
    if (slot) (out.set(slot, m), used.add(m.id));
  }
  return out;
}

/** What an empty side is waiting for, e.g. "Winner Upper QF 1" or "Group A 2nd". */
export function feederLabel(slot: string, side: BracketSide): string | undefined {
  for (const d of SLOTS) {
    const place = d.slot.endsWith(":UF") || d.slot.endsWith(":LF") ? d.slot[0] : undefined;
    if (d.winner?.[0] === slot && d.winner[1] === side) return place ? `Group ${place} ${d.slot.endsWith(":UF") ? "1st" : "3rd"}` : `Winner ${d.short}`;
    if (d.loser?.[0] === slot && d.loser[1] === side) return place ? `Group ${place} 2nd` : `Loser ${d.short}`;
  }
  return undefined;
}

/** Bo per slot from the event's settings. */
export function bestOfFor(slot: string, cfg: NonNullable<EsportsEvent["bracket"]>): 1 | 3 | 5 {
  const k = slotDef(slot)?.kind;
  return k === "qf" ? cfg.qfBestOf : k === "sf" ? cfg.sfBestOf : k === "gf" ? cfg.gfBestOf : cfg.groupBestOf;
}

/* ------------------------------ Diagram view ------------------------------ */

export interface BracketCell {
  def: SlotDef;
  match?: Match;
}
export interface BracketView {
  groups: { name: string; upper: BracketCell[][]; lower: BracketCell[][] }[];
  playoffs: BracketCell[][];
}

/** Columns of cells for the diagram, from the event's matches that carry a slot. */
export function bracketView(ev: EsportsEvent, matches: Match[]): BracketView | undefined {
  if (!ev.bracket) return undefined;
  const bySlot = new Map(matches.filter((m) => m.slot).map((m) => [m.slot!, m]));
  if (!bySlot.size) return undefined;
  const cols = (defs: SlotDef[]) => [0, 1, 2].map((c) => defs.filter((d) => d.column === c).map((def) => ({ def, match: bySlot.get(def.slot) })));
  return {
    groups: GROUPS.map((g) => {
      const defs = SLOTS.filter((d) => d.slot.startsWith(`${g}:`));
      return { name: `Group ${g}`, upper: cols(defs.filter((d) => d.part === "upper")), lower: cols(defs.filter((d) => d.part === "lower")) };
    }),
    playoffs: cols(SLOTS.filter((d) => d.part === "playoffs")),
  };
}
