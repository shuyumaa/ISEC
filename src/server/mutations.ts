import { mapDecided, seriesScore } from "../data";
import type {
  Article,
  EsportsEvent,
  EventStatus,
  EventTier,
  MapName,
  MapResult,
  Match,
  MatchStatus,
  Player,
  PlayerMapStats,
  RankingEntry,
  Role,
  Side,
  Team,
  VetoStep,
} from "../data/types";
import { snapshot, transaction } from "./db";
import {
  FormError,
  bool,
  int,
  isoDate,
  lines,
  localDateTime,
  num,
  oneOf,
  optionalText,
  paragraphs,
  slugify,
  text,
  timeZone,
} from "./forms";

export const MAP_POOL: MapName[] = ["Mirage", "Inferno", "Nuke", "Ancient", "Anubis", "Dust2", "Train"];
export const ROLES: Role[] = ["IGL", "AWP", "Entry", "Support", "Lurker", "Rifler"];
export const TIERS: EventTier[] = ["Major", "Premier", "Open", "Academy"];
export const EVENT_STATUSES: EventStatus[] = ["upcoming", "ongoing", "completed"];
export const MATCH_STATUSES: MatchStatus[] = ["upcoming", "live", "completed"];
export const CATEGORIES: Article["category"][] = ["Announcement", "Interview", "Recap", "Analysis", "Roster"];

const ACTOR = "admin";
const clone = <T>(v: T): T => structuredClone(v);

/* ================================ Matches ================================ */

function getMatch(id: string): Match {
  const m = snapshot().matches.find((x) => x.id === id);
  if (!m) throw new FormError("Match not found.");
  return clone(m);
}

function requireTeam(slug: string, label: string) {
  if (!snapshot().teams.some((t) => t.slug === slug)) throw new FormError(`${label}: unknown team.`);
  return slug;
}

function requireEvent(slug: string) {
  if (!snapshot().events.some((e) => e.slug === slug)) throw new FormError("Unknown event.");
  return slug;
}

/**
 * Keep first-half / second-half splits consistent with the running score.
 * Up to round 12 everything is first half; after that the first-half split is
 * frozen and the remainder is the second half (plus overtime).
 */
function syncHalves(map: MapResult) {
  const a = map.scoreA ?? 0;
  const b = map.scoreB ?? 0;
  if (a + b <= 12) {
    map.halfA = [a, 0];
    map.halfB = [b, 0];
  } else if (map.halfA && map.halfB && map.halfA[0] + map.halfB[0] === 12) {
    map.halfA = [map.halfA[0], Math.max(0, a - map.halfA[0])];
    map.halfB = [map.halfB[0], Math.max(0, b - map.halfB[0])];
  } else {
    // Split unknown (e.g. score typed in directly): don't invent one.
    delete map.halfA;
    delete map.halfB;
  }
}

/** Recompute the derived fields and enforce the series rules after any edit. */
function normalise(m: Match): Match {
  const [a, b] = seriesScore(m);
  m.seriesA = a;
  m.seriesB = b;
  const needed = Math.ceil(m.bestOf / 2);
  if ((a >= needed || b >= needed) && m.status === "live") m.status = "completed";
  if (m.status !== "live") for (const map of m.maps) delete map.live;
  if (m.status === "completed") {
    // Maps that were never played stay empty.
    for (const map of m.maps) if (!mapDecided(map)) {
      delete map.scoreA;
      delete map.scoreB;
      delete map.halfA;
      delete map.halfB;
    }
  }
  return m;
}

function saveMatch(m: Match, action: string) {
  normalise(m);
  transaction((tx) => tx.put("match", m.id, m), ACTOR, action);
  return m;
}

function resizeMaps(m: Match) {
  const used = new Set(m.maps.map((x) => x.map));
  while (m.maps.length < m.bestOf) {
    const next = MAP_POOL.find((p) => !used.has(p)) ?? "Mirage";
    used.add(next);
    m.maps.push({ map: next });
  }
  if (m.maps.length > m.bestOf) m.maps = m.maps.slice(0, m.bestOf);
}

function readMeta(form: FormData, m: Partial<Match>) {
  m.event = requireEvent(text(form, "event", { required: true, label: "Event" }));
  m.stage = text(form, "stage", { required: true, max: 80, label: "Stage" });
  m.bestOf = Number(oneOf(form, "bestOf", ["1", "3", "5"] as const, "Format")) as 1 | 3 | 5;
  m.start = localDateTime(form, "start", "Start time");
  m.teamA = requireTeam(text(form, "teamA", { required: true }), "Team A");
  m.teamB = requireTeam(text(form, "teamB", { required: true }), "Team B");
  if (m.teamA === m.teamB) throw new FormError("Team A and Team B must be different.", "teamB");
  m.stars = int(form, "stars", { min: 0, max: 3, label: "Stars" }) as 0 | 1 | 2 | 3 ?? 0;
}

export function createMatch(form: FormData): Match {
  const ids = snapshot().matches.map((x) => Number(x.id)).filter(Number.isFinite);
  const m: Match = {
    id: String(Math.max(2380000, ...ids) + 1),
    event: "",
    stage: "",
    bestOf: 3,
    status: "upcoming",
    start: "",
    teamA: "",
    teamB: "",
    seriesA: 0,
    seriesB: 0,
    maps: [],
    veto: [],
    stars: 0,
  };
  readMeta(form, m);
  resizeMaps(m);
  return saveMatch(m, "create match");
}

export function updateMatch(id: string, intent: string, form: FormData): Match {
  const m = getMatch(id);

  switch (intent) {
    case "meta": {
      readMeta(form, m);
      resizeMaps(m);
      return saveMatch(m, "edit match details");
    }

    case "status": {
      const status = oneOf(form, "status", MATCH_STATUSES, "Status");
      m.status = status;
      if (status === "live" && !m.maps.some((x) => x.live)) {
        const next = m.maps.find((x) => !mapDecided(x));
        if (next) {
          next.live = true;
          next.scoreA ??= 0;
          next.scoreB ??= 0;
          syncHalves(next);
        }
      }
      if (status === "upcoming") {
        for (const map of m.maps) {
          delete map.scoreA;
          delete map.scoreB;
          delete map.halfA;
          delete map.halfB;
          delete map.live;
          delete map.stats;
        }
      }
      return saveMatch(m, `set status ${status}`);
    }

    case "round": {
      const index = int(form, "map", { required: true, min: 0, max: m.maps.length - 1 })!;
      const side = oneOf(form, "side", ["A", "B"] as const);
      const delta = Number(oneOf(form, "delta", ["1", "-1"] as const));
      const map = m.maps[index]!;
      if (m.status === "completed") throw new FormError("This match is already completed.");
      m.status = "live";
      for (const other of m.maps) if (other !== map) delete other.live;
      map.live = true;
      const key = side === "A" ? "scoreA" : "scoreB";
      map.scoreA ??= 0;
      map.scoreB ??= 0;
      map[key] = Math.max(0, map[key]! + delta);
      syncHalves(map);

      // Map over? Close it, and open the next one unless the series is decided.
      const trial = { ...map, live: false };
      if (mapDecided(trial)) {
        delete map.live;
        const [a, b] = seriesScore(m);
        const needed = Math.ceil(m.bestOf / 2);
        if (a >= needed || b >= needed) {
          m.status = "completed";
        } else {
          const next = m.maps.find((x) => !mapDecided(x) && x !== map);
          if (next) {
            next.live = true;
            next.scoreA = 0;
            next.scoreB = 0;
            syncHalves(next);
          }
        }
      }
      return saveMatch(m, `round ${side}${delta > 0 ? "+1" : "−1"} on ${map.map}`);
    }

    case "map": {
      const index = int(form, "map", { required: true, min: 0, max: m.maps.length - 1 })!;
      const map = m.maps[index]!;
      map.map = oneOf(form, "mapName", MAP_POOL, "Map");
      const pick = text(form, "pickedBy");
      map.pickedBy = pick === "A" ? m.teamA : pick === "B" ? m.teamB : undefined;
      const sa = int(form, "scoreA", { min: 0, max: 99, label: "Team A rounds" });
      const sb = int(form, "scoreB", { min: 0, max: 99, label: "Team B rounds" });
      if ((sa === undefined) !== (sb === undefined)) throw new FormError("Enter both scores, or leave both empty.", "scoreA");
      map.scoreA = sa;
      map.scoreB = sb;
      const side = text(form, "startSideA");
      map.startSideA = side === "CT" || side === "T" ? (side as Side) : undefined;
      const ha = int(form, "halfA", { min: 0, max: 12, label: "Team A first half" });
      const hb = int(form, "halfB", { min: 0, max: 12, label: "Team B first half" });
      if (ha !== undefined && hb !== undefined && sa !== undefined && sb !== undefined) {
        if (ha + hb !== 12 && sa + sb > 12) throw new FormError("First-half rounds must add up to 12.", "halfA");
        map.halfA = [ha, 0];
        map.halfB = [hb, 0];
      }
      if (sa === undefined) {
        delete map.halfA;
        delete map.halfB;
        delete map.live;
      } else {
        syncHalves(map);
        if (bool(form, "live")) {
          for (const other of m.maps) delete other.live;
          map.live = true;
          m.status = "live";
        } else {
          delete map.live;
        }
      }
      return saveMatch(m, `edit map ${index + 1}`);
    }

    case "stats": {
      const index = int(form, "map", { required: true, min: 0, max: m.maps.length - 1 })!;
      const map = m.maps[index]!;
      const rounds = Math.max(1, (map.scoreA ?? 0) + (map.scoreB ?? 0));
      const roster = snapshot().players.filter((p) => p.team === m.teamA || p.team === m.teamB);
      const stats: PlayerMapStats[] = [];
      for (const p of roster) {
        const k = int(form, `k_${p.slug}`, { min: 0, max: 200, label: `${p.nickname} kills` });
        const d = int(form, `d_${p.slug}`, { min: 0, max: 200, label: `${p.nickname} deaths` });
        if (k === undefined && d === undefined) continue;
        const kills = k ?? 0;
        const deaths = d ?? 0;
        const adr = num(form, `adr_${p.slug}`, { min: 0, max: 400, label: `${p.nickname} ADR` }) ?? Number(((kills / rounds) * 118).toFixed(1));
        const kast = num(form, `kast_${p.slug}`, { min: 0, max: 100, label: `${p.nickname} KAST` }) ?? 70;
        const rating =
          num(form, `rating_${p.slug}`, { min: 0, max: 5, label: `${p.nickname} rating` }) ??
          Number((((kills / rounds) / 0.68) * 0.45 + ((1 - deaths / rounds) / 0.32) * 0.25 + (adr / 76) * 0.3).toFixed(2));
        stats.push({
          player: p.slug,
          kills,
          deaths,
          assists: int(form, `a_${p.slug}`, { min: 0, max: 200 }) ?? 0,
          adr,
          kast,
          hs: num(form, `hs_${p.slug}`, { min: 0, max: 100 }) ?? 0,
          rating,
        });
      }
      if (stats.length) map.stats = stats;
      else delete map.stats;
      return saveMatch(m, `edit stats map ${index + 1}`);
    }

    case "veto": {
      const veto: VetoStep[] = [];
      for (let i = 0; i < 7; i++) {
        const mapName = text(form, `veto_map_${i}`);
        if (!mapName) continue;
        if (!MAP_POOL.includes(mapName as MapName)) throw new FormError(`Veto step ${i + 1}: unknown map.`);
        const who = text(form, `veto_team_${i}`);
        const action = oneOf(form, `veto_action_${i}`, ["removed", "picked", "left over"] as const, `Veto step ${i + 1}`);
        veto.push({ team: who === "A" ? m.teamA : who === "B" ? m.teamB : undefined, action, map: mapName as MapName });
      }
      m.veto = veto;
      return saveMatch(m, "edit veto");
    }

    default:
      throw new FormError("Unknown action.");
  }
}

export function deleteMatch(id: string) {
  getMatch(id);
  transaction((tx) => tx.remove("match", id), ACTOR, "delete match");
}

/* ================================= News ================================== */

export function saveArticle(slug: string | undefined, form: FormData): Article {
  const title = text(form, "title", { required: true, max: 160, label: "Title" });
  const existing = slug ? snapshot().articles.find((a) => a.slug === slug) : undefined;
  let newSlug = existing?.slug ?? slugify(title);
  if (!existing) {
    let n = 2;
    const base = newSlug || "article";
    while (snapshot().articles.some((a) => a.slug === newSlug)) newSlug = `${base}-${n++}`;
  }
  const teams = form.getAll("teams").map(String).filter((t) => snapshot().teams.some((x) => x.slug === t));
  const eventSlug = text(form, "relatedEvent");
  const article: Article = {
    slug: newSlug,
    title,
    summary: text(form, "summary", { required: true, max: 300, label: "Summary" }),
    category: oneOf(form, "category", CATEGORIES, "Category"),
    author: text(form, "author", { required: true, max: 80, label: "Author" }),
    published: isoDate(form, "published", "Publish date"),
    readMinutes: int(form, "readMinutes", { min: 1, max: 60, label: "Read time" }) ?? 3,
    body: paragraphs(form, "body"),
    related: {
      teams: teams.length ? teams : undefined,
      event: eventSlug && snapshot().events.some((e) => e.slug === eventSlug) ? eventSlug : undefined,
    },
  };
  if (!article.body.length) throw new FormError("Body is required.", "body");
  transaction((tx) => tx.put("article", article.slug, article), ACTOR, existing ? "edit article" : "publish article");
  return article;
}

export function deleteArticle(slug: string) {
  transaction((tx) => tx.remove("article", slug), ACTOR, "delete article");
}

/* ============================ Teams & players ============================ */

export function saveTeam(slug: string | undefined, form: FormData): Team {
  const name = text(form, "name", { required: true, max: 60, label: "Name" });
  const existing = slug ? snapshot().teams.find((t) => t.slug === slug) : undefined;
  const newSlug = existing?.slug ?? slugify(name);
  if (!existing && snapshot().teams.some((t) => t.slug === newSlug)) throw new FormError("A team with this name already exists.", "name");
  const t: Team = {
    slug: newSlug,
    name,
    tag: text(form, "tag", { required: true, max: 4, label: "Tag" }).toUpperCase(),
    country: text(form, "country", { required: true, max: 60, label: "Country" }),
    countryCode: text(form, "countryCode", { required: true, max: 2, label: "Country code" }).toUpperCase(),
    founded: int(form, "founded", { required: true, min: 1990, max: 2100, label: "Founded" })!,
    coach: text(form, "coach", { max: 60 }),
  };
  transaction((tx) => {
    tx.put("team", t.slug, t);
    // New teams enter the ranking at the bottom.
    if (!existing) tx.put("ranking", t.slug, { team: t.slug, points: 0, change: 0 } satisfies RankingEntry);
  }, ACTOR, existing ? "edit team" : "create team");
  return t;
}

export function deleteTeam(slug: string) {
  const s = snapshot();
  if (s.matches.some((m) => m.teamA === slug || m.teamB === slug)) throw new FormError("This team has matches. Delete or reassign them first.");
  transaction((tx) => {
    tx.remove("team", slug);
    tx.remove("ranking", slug);
    for (const p of s.players.filter((x) => x.team === slug)) tx.remove("player", p.slug);
  }, ACTOR, "delete team");
}

export function savePlayer(teamSlug: string, slug: string | undefined, form: FormData): Player {
  const nickname = text(form, "nickname", { required: true, max: 32, label: "Nickname" });
  const existing = slug ? snapshot().players.find((p) => p.slug === slug) : undefined;
  let newSlug = existing?.slug ?? slugify(nickname);
  if (!existing && snapshot().players.some((p) => p.slug === newSlug)) newSlug = `${newSlug}-${teamSlug}`;
  const team = snapshot().teams.find((t) => t.slug === teamSlug);
  if (!team) throw new FormError("Unknown team.");
  const p: Player = {
    slug: newSlug,
    nickname,
    firstName: text(form, "firstName", { max: 40 }),
    lastName: text(form, "lastName", { max: 40 }),
    team: teamSlug,
    role: oneOf(form, "role", ROLES, "Role"),
    countryCode: (optionalText(form, "countryCode", { max: 2 }) ?? team.countryCode).toUpperCase(),
    age: int(form, "age", { min: 12, max: 60, label: "Age" }) ?? 0,
  };
  transaction((tx) => tx.put("player", p.slug, p), ACTOR, existing ? "edit player" : "add player");
  return p;
}

export function deletePlayer(slug: string) {
  transaction((tx) => tx.remove("player", slug), ACTOR, "remove player");
}

/* ================================ Events ================================= */

export function saveEvent(slug: string | undefined, form: FormData): EsportsEvent {
  const name = text(form, "name", { required: true, max: 100, label: "Name" });
  const existing = slug ? snapshot().events.find((e) => e.slug === slug) : undefined;
  const newSlug = existing?.slug ?? slugify(name);
  if (!existing && snapshot().events.some((e) => e.slug === newSlug)) throw new FormError("An event with this name already exists.", "name");
  const startDate = isoDate(form, "startDate", "Start date");
  const endDate = isoDate(form, "endDate", "End date");
  if (endDate < startDate) throw new FormError("End date must be on or after the start date.", "endDate");
  const teamSlugs = new Set(snapshot().teams.map((t) => t.slug));
  const prizes = lines(form, "prizes").map((line, i) => {
    const [place, prize, team] = line.split("|").map((x) => x.trim());
    const amount = Number((prize ?? "").replace(/[^\d.]/g, ""));
    if (!place || !Number.isFinite(amount)) throw new FormError(`Prize line ${i + 1} must look like "1st | 100000 | team-slug".`, "prizes");
    if (team && !teamSlugs.has(team)) throw new FormError(`Prize line ${i + 1}: unknown team "${team}".`, "prizes");
    return { place, prize: amount, team: team || undefined };
  });
  const winner = text(form, "winner");
  const ev: EsportsEvent = {
    slug: newSlug,
    name,
    tier: oneOf(form, "tier", TIERS, "Tier"),
    status: oneOf(form, "status", EVENT_STATUSES, "Status"),
    startDate,
    endDate,
    timeZone: timeZone(form, "timeZone", "Time zone"),
    location: text(form, "location", { required: true, max: 100, label: "Location" }),
    online: bool(form, "online"),
    prizePool: int(form, "prizePool", { min: 0, max: 100_000_000, label: "Prize pool" }) ?? 0,
    teams: form.getAll("teams").map(String).filter((t) => teamSlugs.has(t)),
    format: lines(form, "format"),
    prizes,
    winner: winner && teamSlugs.has(winner) ? winner : undefined,
  };
  transaction((tx) => tx.put("event", ev.slug, ev), ACTOR, existing ? "edit event" : "create event");
  return ev;
}

export function deleteEvent(slug: string) {
  if (snapshot().matches.some((m) => m.event === slug)) throw new FormError("This event has matches. Delete them first.");
  transaction((tx) => tx.remove("event", slug), ACTOR, "delete event");
}

/* ================================ Ranking ================================ */

export function saveRanking(form: FormData) {
  const s = snapshot();
  const before = new Map(s.ranking.map((r, i) => [r.team, i + 1]));
  const entries = s.teams.map((t) => ({
    team: t.slug,
    points: int(form, `points_${t.slug}`, { min: 0, max: 100000, label: `${t.name} points` }) ?? 0,
  }));
  entries.sort((a, b) => b.points - a.points);
  const updated = isoDate(form, "updated", "Ranking date");
  const autoChange = bool(form, "autoChange");
  transaction((tx) => {
    entries.forEach((e, i) => {
      const prev = before.get(e.team);
      const manual = int(form, `change_${e.team}`, { min: -100, max: 100 }) ?? 0;
      const change = autoChange ? (prev ? prev - (i + 1) : 0) : manual;
      tx.put("ranking", e.team, { team: e.team, points: e.points, change } satisfies RankingEntry);
    });
    tx.put("meta", "rankingUpdated", { key: "rankingUpdated", value: updated });
  }, ACTOR, "publish ranking");
}
