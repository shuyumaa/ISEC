import { tool } from "ai";
import { z } from "zod";
import { findEvent, findMatch, findPlayer, findTeam, getEvents, getMatches, getPlayers, getTeams, matchRoster, rosterOf, team } from "../../data";
import type { EsportsEvent, Player } from "../../data/types";
import { runAs } from "../actor";
import { FormError } from "../forms";
import { EVENT_STATUSES, MAP_POOL, MATCH_STATUSES, PLAYER_STATUSES, ROLES, TIERS, createMatch, saveEvent, savePlayer, saveTeam, setPlayerStatus, updateMatch } from "../mutations";

/*
 * What the admin assistant can do. Read tools run straight away; every tool
 * that changes data is listed in WRITE_TOOLS and needs the admin's approval in
 * the chat before it runs (see agent.ts). Writes go through the same mutation
 * functions, and so the same validation, as the admin forms.
 */

const slug = z.string().min(1).max(80);
const role = z.enum(ROLES as [string, ...string[]]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const brief = {
  team: (t: { slug: string; name: string; tag: string }) => ({ slug: t.slug, name: t.name, tag: t.tag }),
  player: (p: Player) => ({ slug: p.slug, nickname: p.nickname, name: `${p.firstName} ${p.lastName}`.trim(), team: p.team || null, status: p.status ?? "active", role: p.role, role2: p.role2 ?? null }),
  event: (e: EsportsEvent) => ({ slug: e.slug, name: e.name, status: e.status, startDate: e.startDate, endDate: e.endDate, teams: e.teams }),
};

const match = (id: string) => {
  const m = findMatch(id);
  if (!m) throw new FormError(`No match with id ${id}.`);
  return m;
};

/** The full form of an existing record, so an edit can change only some fields. */
function eventForm(e: EsportsEvent) {
  const f = new FormData();
  const set = (k: string, v: unknown) => v !== undefined && v !== null && v !== "" && f.append(k, String(v));
  set("name", e.name);
  set("tier", e.tier);
  set("status", e.status);
  set("startDate", e.startDate);
  set("endDate", e.endDate);
  set("timeZone", e.timeZone);
  set("location", e.location);
  if (e.online) f.set("online", "on");
  set("prizePool", e.prizePool);
  for (const t of e.teams) f.append("teams", t);
  set("format", e.format.join("\n"));
  for (const p of e.prizes) {
    f.append("prizePlace", p.place);
    f.append("prizeAmount", String(p.prize));
    f.append("prizeTeam", p.team ?? "");
  }
  set("winner", e.winner);
  set("mvp", e.mvp);
  for (const x of e.evps ?? []) f.append("evps", x);
  for (const m of e.mapPool ?? []) f.append("mapPool", m);
  for (const r of e.related ?? []) f.append("related", r);
  if (e.swiss) {
    set("swissStage", e.swiss.stage);
    set("swissWins", e.swiss.wins);
    set("swissLosses", e.swiss.losses);
  }
  return f;
}

function playerForm(p: Player) {
  const f = new FormData();
  const set = (k: string, v: unknown) => v !== undefined && v !== null && f.set(k, String(v));
  set("nickname", p.nickname);
  set("firstName", p.firstName);
  set("lastName", p.lastName);
  set("countryCode", p.countryCode);
  set("age", p.age || "");
  set("role", p.role);
  set("role2", p.role2 ?? "");
  set("team", p.team);
  set("status", p.status ?? (p.team ? "active" : "free"));
  set("ign", p.ign ?? "");
  set("steamId", p.steamId ?? "");
  set("joined", p.joined ?? "");
  return f;
}

const eventFields = {
  name: z.string().min(1).max(100).optional(),
  tier: z.enum(TIERS as [string, ...string[]]).optional(),
  status: z.enum(EVENT_STATUSES as [string, ...string[]]).optional(),
  startDate: date.optional(),
  endDate: date.optional(),
  timeZone: z.string().optional().describe("IANA time zone, e.g. Asia/Shanghai"),
  location: z.string().max(100).optional(),
  online: z.boolean().optional(),
  prizePool: z.number().int().min(0).optional(),
  teams: z.array(slug).optional().describe("Team slugs attending (replaces the list)"),
  format: z.array(z.string()).optional().describe("Format lines, e.g. 'Swiss stage, Bo1'"),
};

function applyEvent(f: FormData, c: Partial<Record<keyof typeof eventFields, unknown>>) {
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined) continue;
    if (k === "teams") {
      f.delete("teams");
      for (const t of v as string[]) f.append("teams", t);
    } else if (k === "format") f.set("format", (v as string[]).join("\n"));
    else if (k === "online") v ? f.set("online", "on") : f.delete("online");
    else f.set(k, String(v));
  }
  return f;
}

const playerFields = {
  nickname: z.string().min(1).max(32).optional(),
  firstName: z.string().max(40).optional(),
  lastName: z.string().max(40).optional(),
  countryCode: z.string().length(2).optional().describe("ISO 3166-1 alpha-2, e.g. CN"),
  age: z.number().int().min(10).max(60).optional(),
  role: role.optional(),
  role2: role.nullable().optional().describe("Second role, e.g. AWP + IGL; null removes it"),
  team: slug.nullable().optional().describe("Team slug; null for no team"),
  status: z.enum(PLAYER_STATUSES as [string, ...string[]]).optional(),
  ign: z.string().max(64).optional(),
  steamId: z.string().max(32).optional(),
};

function applyPlayer(f: FormData, c: Record<string, unknown>) {
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined) continue;
    f.set(k, v === null ? "" : String(v));
  }
  if (c.team && !c.status && f.get("status") === "free") f.set("status", "active");
  return f;
}

const statLine = z.object({
  player: z.string().describe("Player slug, nickname or in-game name"),
  kills: z.number().int().min(0),
  deaths: z.number().int().min(0),
  assists: z.number().int().min(0).optional(),
  adr: z.number().min(0).optional(),
  kast: z.number().min(0).max(100).optional(),
  hs: z.number().min(0).max(100).optional().describe("Headshot %"),
  rating: z.number().min(0).max(5).optional(),
});

/** Record stats for one map, matching names against both rosters. */
export function recordStats(matchId: string, mapIndex: number, lines: z.infer<typeof statLine>[]) {
  const m = match(matchId);
  const roster = matchRoster(m);
  const norm = (x: string) => x.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const f = new FormData();
  f.set("map", String(mapIndex));
  const unknown: string[] = [];
  for (const l of lines) {
    const p = roster.find((x) => [x.slug, x.nickname, x.ign ?? "", x.steamId ?? ""].some((v) => v && norm(v) === norm(l.player)));
    if (!p) {
      unknown.push(l.player);
      continue;
    }
    const put = (k: string, v?: number) => v !== undefined && f.set(`${k}_${p.slug}`, String(v));
    put("k", l.kills);
    put("d", l.deaths);
    put("a", l.assists);
    put("adr", l.adr);
    put("kast", l.kast);
    put("hs", l.hs);
    put("rating", l.rating);
  }
  if (unknown.length) throw new FormError(`Not on either roster: ${unknown.join(", ")}. Use player slugs from getMatch.`);
  updateMatch(m.id, "stats", f);
  return { ok: true, saved: lines.length };
}

export function adminTools(actorName: string) {
  // Writes are attributed in the audit log to the admin who approved them.
  const as = <T>(fn: () => T) => runAs(`${actorName} (assistant)`, fn);
  return {
    /* ------------------------------- Read ------------------------------- */
    search: tool({
      description: "Find teams, players, events and matches by name. Use this first to get slugs and match ids.",
      inputSchema: z.object({ query: z.string().min(1).max(60) }),
      execute: ({ query }) => {
        const q = query.toLowerCase();
        const has = (...xs: (string | undefined)[]) => xs.some((x) => x?.toLowerCase().includes(q));
        return {
          teams: getTeams().filter((t) => has(t.name, t.tag, t.slug)).slice(0, 10).map(brief.team),
          players: getPlayers().filter((p) => has(p.nickname, p.firstName, p.lastName, p.slug, p.ign)).slice(0, 10).map(brief.player),
          events: getEvents().filter((e) => has(e.name, e.slug)).slice(0, 10).map(brief.event),
          matches: getMatches()
            .filter((m) => has(team(m.teamA).name, team(m.teamB).name, m.id, m.stage))
            .slice(0, 10)
            .map((m) => ({ id: m.id, event: m.event, stage: m.stage, start: m.start, status: m.status, teamA: m.teamA || "TBD", teamB: m.teamB || "TBD" })),
        };
      },
    }),
    listTeams: tool({
      description: "All teams with their slugs.",
      inputSchema: z.object({}),
      execute: () => getTeams().map(brief.team),
    }),
    getTeam: tool({
      description: "A team and its roster (starters and bench).",
      inputSchema: z.object({ slug }),
      execute: ({ slug: s }) => {
        const t = findTeam(s);
        if (!t) throw new FormError(`No team "${s}".`);
        return { ...brief.team(t), countryCode: t.countryCode, coach: t.coach, roster: rosterOf(t.slug).map(brief.player) };
      },
    }),
    getPlayer: tool({
      description: "One player's profile.",
      inputSchema: z.object({ slug }),
      execute: ({ slug: s }) => {
        const p = findPlayer(s);
        if (!p) throw new FormError(`No player "${s}".`);
        return { ...brief.player(p), countryCode: p.countryCode, age: p.age, ign: p.ign, steamId: p.steamId };
      },
    }),
    listEvents: tool({
      description: "All events.",
      inputSchema: z.object({}),
      execute: () => getEvents().map(brief.event),
    }),
    getEvent: tool({
      description: "An event with its settings and matches.",
      inputSchema: z.object({ slug }),
      execute: ({ slug: s }) => {
        const e = findEvent(s);
        if (!e) throw new FormError(`No event "${s}".`);
        return { ...e, matches: getMatches().filter((m) => m.event === e.slug).map((m) => ({ id: m.id, stage: m.stage, start: m.start, status: m.status, teamA: m.teamA || "TBD", teamB: m.teamB || "TBD" })) };
      },
    }),
    getMatch: tool({
      description: "A match with its maps (index from 0), scores and both rosters.",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => {
        const m = match(id);
        return {
          id: m.id,
          event: m.event,
          stage: m.stage,
          bestOf: m.bestOf,
          start: m.start,
          status: m.status,
          teamA: m.teamA ? brief.team(team(m.teamA)) : "TBD",
          teamB: m.teamB ? brief.team(team(m.teamB)) : "TBD",
          maps: m.maps.map((x, i) => ({ index: i, map: x.map, scoreA: x.scoreA ?? null, scoreB: x.scoreB ?? null, hasStats: !!x.stats?.length })),
          roster: matchRoster(m).map((p) => ({ slug: p.slug, nickname: p.nickname, ign: p.ign, team: p.team })),
        };
      },
    }),

    /* ------------------------------- Write ------------------------------ */
    createEvent: tool({
      description: "Create an event. Ask for anything required that the admin didn't say.",
      inputSchema: z.object({
        ...eventFields,
        name: z.string().min(1).max(100),
        tier: eventFields.tier.unwrap(),
        status: eventFields.status.unwrap(),
        startDate: date,
        endDate: date,
        timeZone: z.string().describe("IANA time zone, e.g. Asia/Shanghai"),
        location: z.string().min(1).max(100),
      }),
      execute: (input) => as(() => brief.event(saveEvent(undefined, applyEvent(new FormData(), input)))),
    }),
    updateEvent: tool({
      description: "Change some fields of an existing event; fields left out stay as they are.",
      inputSchema: z.object({ slug, changes: z.object(eventFields) }),
      execute: ({ slug: s, changes }) =>
        as(() => {
          const e = findEvent(s);
          if (!e) throw new FormError(`No event "${s}".`);
          return brief.event(saveEvent(e.slug, applyEvent(eventForm(e), changes)));
        }),
    }),
    createTeam: tool({
      description: "Create a team.",
      inputSchema: z.object({
        name: z.string().min(1).max(60),
        tag: z.string().min(2).max(4),
        countryCode: z.string().length(2),
        founded: z.number().int().min(1990).max(2100),
        coach: z.string().max(60).optional(),
      }),
      execute: (input) =>
        as(() => {
          const f = new FormData();
          for (const [k, v] of Object.entries(input)) if (v !== undefined) f.set(k, String(v));
          return brief.team(saveTeam(undefined, f));
        }),
    }),
    createPlayer: tool({
      description: "Add a new player, optionally straight onto a team.",
      inputSchema: z.object({ ...playerFields, nickname: z.string().min(1).max(32), role: role.default("Rifler") }),
      execute: (input) =>
        as(() => {
          const f = applyPlayer(new FormData(), { status: input.team ? "active" : "free", ...input });
          f.set("moveNote", "Added by the assistant");
          return brief.player(savePlayer(undefined, f));
        }),
    }),
    updatePlayer: tool({
      description: "Change some fields of a player (profile, roles, team, status). Fields left out stay as they are. A team or status change records a transfer.",
      inputSchema: z.object({ slug, changes: z.object(playerFields), note: z.string().max(120).optional().describe("Note for the transfer history") }),
      execute: ({ slug: s, changes, note }) =>
        as(() => {
          const p = findPlayer(s);
          if (!p) throw new FormError(`No player "${s}".`);
          const f = applyPlayer(playerForm(p), changes);
          if (note) f.set("moveNote", note);
          return brief.player(savePlayer(p.slug, f));
        }),
    }),
    setPlayerStatus: tool({
      description: "Quick roster move: sign to a team (status active + team), bench, activate, release (free) or retire.",
      inputSchema: z.object({ slug, status: z.enum(PLAYER_STATUSES as [string, ...string[]]), team: slug.optional() }),
      execute: ({ slug: s, status, team: t }) => as(() => brief.player(setPlayerStatus(s, status as Player["status"] & string, t))),
    }),
    scheduleMatches: tool({
      description: "Schedule several matches of one event at once (e.g. a whole bracket with TBD teams). One approval covers the batch; prefer this over many scheduleMatch calls.",
      inputSchema: z.object({
        event: slug,
        matches: z
          .array(
            z.object({
              stage: z.string().min(1).max(80),
              bestOf: z.union([z.literal(1), z.literal(3), z.literal(5)]),
              start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe("Local time in the event's time zone"),
              teamA: slug.optional(),
              teamB: slug.optional(),
            }),
          )
          .min(1)
          .max(40),
      }),
      execute: ({ event, matches }) =>
        as(() => {
          // Check every row first, so a bad row doesn't leave half a bracket behind.
          if (!findEvent(event)) throw new FormError(`No event "${event}".`);
          matches.forEach((x, i) => {
            for (const t of [x.teamA, x.teamB]) if (t && !findTeam(t)) throw new FormError(`Match ${i + 1}: no team "${t}".`);
            if (x.teamA && x.teamA === x.teamB) throw new FormError(`Match ${i + 1}: a team can't play itself.`);
          });
          const forms = matches.map((x) => {
            const f = new FormData();
            f.set("event", event);
            for (const [k, v] of Object.entries(x)) if (v !== undefined) f.set(k, String(v));
            return f;
          });
          const created = forms.map((f) => createMatch(f).id);
          return { created: created.length, ids: created, url: `/admin/matches/?event=${encodeURIComponent(event)}` };
        }),
    }),
    scheduleMatch: tool({
      description: "Schedule a match. Teams may be left out (TBD) for brackets that aren't decided yet.",
      inputSchema: z.object({
        event: slug,
        stage: z.string().min(1).max(80).describe("e.g. 'Quarter-final' or 'Swiss round 1'"),
        bestOf: z.union([z.literal(1), z.literal(3), z.literal(5)]),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe("Local time in the event's time zone, YYYY-MM-DDTHH:mm"),
        teamA: slug.optional(),
        teamB: slug.optional(),
        stars: z.number().int().min(0).max(3).optional(),
      }),
      execute: (input) =>
        as(() => {
          const f = new FormData();
          for (const [k, v] of Object.entries(input)) if (v !== undefined) f.set(k, String(v));
          const m = createMatch(f);
          return { id: m.id, url: `/admin/matches/${m.id}/` };
        }),
    }),
    setMapResult: tool({
      description: "Set the final score of one map of a match (map index from getMatch).",
      inputSchema: z.object({
        matchId: z.string(),
        mapIndex: z.number().int().min(0).max(4),
        map: z.enum(MAP_POOL as [string, ...string[]]).optional(),
        scoreA: z.number().int().min(0).max(99),
        scoreB: z.number().int().min(0).max(99),
      }),
      execute: ({ matchId, mapIndex, map, scoreA, scoreB }) =>
        as(() => {
          const m = match(matchId);
          const cur = m.maps[mapIndex];
          if (!cur) throw new FormError(`This match has only ${m.maps.length} maps.`);
          const f = new FormData();
          f.set("map", String(mapIndex));
          f.set("mapName", map ?? cur.map);
          f.set("pickedBy", cur.pickedBy === m.teamA ? "A" : cur.pickedBy === m.teamB ? "B" : "");
          f.set("scoreA", String(scoreA));
          f.set("scoreB", String(scoreB));
          if (cur.startSideA) f.set("startSideA", cur.startSideA);
          const saved = updateMatch(m.id, "map", f);
          return { status: saved.status, maps: saved.maps.map((x) => `${x.map} ${x.scoreA ?? "-"}:${x.scoreB ?? "-"}`) };
        }),
    }),
    recordMapStats: tool({
      description: "Record per-player stats for one map (e.g. read from a scoreboard screenshot). Replaces existing stats for that map.",
      inputSchema: z.object({ matchId: z.string(), mapIndex: z.number().int().min(0).max(4), players: z.array(statLine).min(1).max(12) }),
      execute: ({ matchId, mapIndex, players }) => as(() => recordStats(matchId, mapIndex, players)),
    }),
    setMatchStatus: tool({
      description: "Set a match to upcoming, live or completed.",
      inputSchema: z.object({ matchId: z.string(), status: z.enum(MATCH_STATUSES as [string, ...string[]]) }),
      execute: ({ matchId, status }) =>
        as(() => {
          const f = new FormData();
          f.set("status", status);
          return { status: updateMatch(match(matchId).id, "status", f).status };
        }),
    }),
  };
}

export const WRITE_TOOLS = ["createEvent", "updateEvent", "createTeam", "createPlayer", "updatePlayer", "setPlayerStatus", "scheduleMatch", "scheduleMatches", "setMapResult", "recordMapStats", "setMatchStatus"] as const;
