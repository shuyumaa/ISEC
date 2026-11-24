import { Output, generateText } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { matchRoster, team } from "../../data";
import type { MapName, Match } from "../../data/types";
import { FormError } from "../forms";
import { MAP_POOL } from "../mutations";
import { sniff } from "../uploads";
import { languageModel } from "./config";

/*
 * Scoreboard reader: a screenshot of an end-of-map scoreboard (CS2, Perfect
 * World, FACEIT, 5E…) becomes a draft of the map score and per-player stats.
 * Nothing is saved here: the admin reviews the draft on the match page and
 * saves it with the normal map + stats validation.
 */

const schema = z.object({
  map: z.enum(MAP_POOL as [MapName, ...MapName[]]).nullable().describe("The map, if the screenshot shows it"),
  teamAScore: z.number().int().min(0).max(99).nullable().describe("Rounds won by team A (see the instructions for which team is A)"),
  teamBScore: z.number().int().min(0).max(99).nullable(),
  players: z
    .array(
      z.object({
        name: z.string().describe("The name exactly as written on the scoreboard"),
        slug: z.string().nullable().describe("The roster slug this name belongs to, or null if unsure"),
        kills: z.number().int().min(0),
        deaths: z.number().int().min(0),
        assists: z.number().int().min(0).nullable(),
        adr: z.number().min(0).nullable(),
        hs: z.number().min(0).max(100).nullable().describe("Headshot percentage"),
        kast: z.number().min(0).max(100).nullable(),
        rating: z.number().min(0).max(5).nullable(),
      }),
    )
    .max(12),
});

export interface StatDraft {
  kills: number;
  deaths: number;
  assists?: number;
  adr?: number;
  hs?: number;
  kast?: number;
  rating?: number;
}
export interface ScoreboardDraft {
  id: string;
  matchId: string;
  mapIndex: number;
  createdAt: number;
  map?: MapName;
  scoreA?: number;
  scoreB?: number;
  /** By player slug. */
  stats: Record<string, StatDraft>;
  /** Names on the screenshot that match nobody on either roster. */
  unmatched: string[];
}

// Drafts live in memory for half an hour: long enough to review, never stored.
const drafts = new Map<string, ScoreboardDraft>();
const TTL = 30 * 60 * 1000;
function prune() {
  const now = Date.now();
  for (const [k, d] of drafts) if (now - d.createdAt > TTL) drafts.delete(k);
  while (drafts.size > 50) drafts.delete(drafts.keys().next().value!);
}
export function getDraft(id: string | null, matchId: string) {
  prune();
  const d = id ? drafts.get(id) : undefined;
  return d && d.matchId === matchId ? d : undefined;
}
export const discardDraft = (id: string) => drafts.delete(id);

const MAX_BYTES = 8 * 1024 * 1024;
const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;

export async function readScoreboard(m: Match, mapIndex: number, file: File): Promise<ScoreboardDraft> {
  if (!m.maps[mapIndex]) throw new FormError("Choose one of this match's maps.", "ocrMap");
  if (!file.size) throw new FormError("Choose a screenshot to read.", "screenshot");
  if (file.size > MAX_BYTES) throw new FormError("The screenshot is larger than 8 MB.", "screenshot");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) throw new FormError("Use a PNG, JPEG or WebP screenshot.", "screenshot");

  const a = team(m.teamA);
  const b = team(m.teamB);
  const roster = matchRoster(m);
  const lines = (slug: string) =>
    roster
      .filter((p) => p.team === slug)
      .map((p) => `  - slug "${p.slug}": ${p.nickname}${p.ign ? ` (in-game "${p.ign}")` : ""}`)
      .join("\n");
  // Players on neither list (stand-ins, renamed accounts) are still offered.
  const others = roster.filter((p) => p.team !== m.teamA && p.team !== m.teamB);

  let output: z.infer<typeof schema>;
  try {
    ({ output } = await generateText({
      model: languageModel(),
      output: Output.object({ schema }),
      abortSignal: AbortSignal.timeout(90_000),
      instructions:
        "You read Counter-Strike 2 end-of-map scoreboards and return only what is visible. Never guess numbers you can't read: use null. Percentages are numbers without the % sign.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Read this scoreboard for map ${mapIndex + 1} (${m.maps[mapIndex]!.map}) of ${a.name} vs ${b.name}.
Team A is ${a.name} (tag ${a.tag}):
${lines(m.teamA) || "  (no roster)"}
Team B is ${b.name} (tag ${b.tag}):
${lines(m.teamB) || "  (no roster)"}${others.length ? `\nOther players who may appear:\n${others.map((p) => `  - slug "${p.slug}": ${p.nickname}`).join("\n")}` : ""}
For every player row return name, slug (from the lists above, or null), K, D, A, ADR, HS%, KAST and rating if shown. Return the round score for team A and team B.`,
            },
            { type: "file", mediaType: MIME[kind], data: bytes },
          ],
        },
      ],
    }));
  } catch (e) {
    if (e instanceof FormError) throw e;
    throw new FormError(`The AI couldn't read the screenshot: ${(e as Error).message.slice(0, 160)}`, "screenshot");
  }

  const norm = (x: string) => x.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const stats: Record<string, StatDraft> = {};
  const unmatched: string[] = [];
  for (const row of output.players) {
    const p =
      roster.find((x) => x.slug === row.slug) ??
      roster.find((x) => [x.nickname, x.ign ?? "", x.steamId ?? ""].some((v) => v && norm(v) === norm(row.name)));
    if (!p || stats[p.slug]) {
      unmatched.push(row.name);
      continue;
    }
    // Rounded to the precision the stats form takes.
    const opt = (v: number | null, dp: number) => (v === null ? undefined : Number(v.toFixed(dp)));
    stats[p.slug] = { kills: row.kills, deaths: row.deaths, assists: opt(row.assists, 0), adr: opt(row.adr, 1), hs: opt(row.hs, 1), kast: opt(row.kast, 1), rating: opt(row.rating, 2) };
  }
  if (!Object.keys(stats).length && !unmatched.length) throw new FormError("No player rows found on that screenshot. Try a sharper or uncropped scoreboard.", "screenshot");

  prune();
  const draft: ScoreboardDraft = {
    id: randomUUID(),
    matchId: m.id,
    mapIndex,
    createdAt: Date.now(),
    map: output.map ?? undefined,
    scoreA: output.teamAScore ?? undefined,
    scoreB: output.teamBScore ?? undefined,
    stats,
    unmatched,
  };
  drafts.set(draft.id, draft);
  return draft;
}
