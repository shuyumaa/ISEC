import { mapDecided, matchRoster, seriesScore } from "../data";
import type {
  EloSettings,
  PlayerStatus,
  Transfer,
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
  Season,
  Settings,
  Side,
  Team,
  VetoStep,
} from "../data/types";
import { snapshot, transaction } from "./db";
import { countryName, isCountry } from "../data/countries";
import { Temporal } from "temporal-polyfill";
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
  uniqueSlug,
  text,
  timeZone,
} from "./forms";

export const MAP_POOL: MapName[] = ["Mirage", "Inferno", "Nuke", "Ancient", "Anubis", "Dust2", "Train"];
export const ROLES: Role[] = ["IGL", "AWP", "Entry", "Support", "Lurker", "Rifler"];
export const TIERS: EventTier[] = ["Major", "Premier", "Open", "Academy"];
export const EVENT_STATUSES: EventStatus[] = ["upcoming", "ongoing", "completed"];
export const MATCH_STATUSES: MatchStatus[] = ["upcoming", "live", "completed"];
export const CATEGORIES: Article["category"][] = ["Announcement", "Interview", "Recap", "Analysis", "Roster"];

import { actor } from "./actor";
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
  transaction((tx) => tx.put("match", m.id, m), actor(), action);
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

/**
 * Set the running score of one map and apply the series rules: the map goes
 * live, closes itself once decided (13, or an overtime win), the next map
 * opens, and the match completes when a team has won enough maps. Shared by
 * the admin round buttons and the game-server feed.
 */
export function applyMapScore(m: Match, index: number, scoreA: number, scoreB: number) {
  const map = m.maps[index];
  if (!map || m.status === "completed") return;
  m.status = "live";
  for (const other of m.maps) if (other !== map) delete other.live;
  map.live = true;
  map.scoreA = Math.max(0, scoreA);
  map.scoreB = Math.max(0, scoreB);
  syncHalves(map);

  if (mapDecided({ ...map, live: false })) {
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
}

export { normalise as normaliseMatch, syncHalves };

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
      const key = side === "A" ? "scoreA" : "scoreB";
      const next = { scoreA: map.scoreA ?? 0, scoreB: map.scoreB ?? 0 };
      next[key] = Math.max(0, next[key] + delta);
      applyMapScore(m, index, next.scoreA, next.scoreB);
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
      const roster = matchRoster(m);
      // A pasted Perfect World / CSV export fills the per-player fields, then the normal validation runs.
      const csv = text(form, "csv", { max: 20000 });
      if (csv) applyStatsCsv(form, csv, roster);
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
          rws: num(form, `rws_${p.slug}`, { min: 0, max: 100, label: `${p.nickname} RWS` }),
          firstKills: int(form, `fk_${p.slug}`, { min: 0, max: 99 }),
          firstDeaths: int(form, `fd_${p.slug}`, { min: 0, max: 99 }),
          clutchesWon: int(form, `cw_${p.slug}`, { min: 0, max: 99 }),
          clutchesPlayed: int(form, `cp_${p.slug}`, { min: 0, max: 99 }),
          utilityDamage: int(form, `ud_${p.slug}`, { min: 0, max: 9999 }),
          flashAssists: int(form, `fa_${p.slug}`, { min: 0, max: 99 }),
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
  transaction((tx) => tx.remove("match", id), actor(), "delete match");
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
  transaction((tx) => tx.put("article", article.slug, article), actor(), existing ? "edit article" : "publish article");
  return article;
}

export function deleteArticle(slug: string) {
  transaction((tx) => tx.remove("article", slug), actor(), "delete article");
}

/* ============================ Teams & players ============================ */

/** `upload`: new file name, `null` to remove, `undefined` to keep the current one. */
type Upload = string | null | undefined;
const pickUpload = (current: string | undefined, next: Upload) => (next === null ? undefined : (next ?? current));

/** Country from the picker: a valid ISO code; the name is derived from it. */
function readCountry(form: FormData, field = "countryCode", required = true): string {
  const code = text(form, field, { required, max: 2, label: "Country" }).toUpperCase();
  if (code && !isCountry(code)) throw new FormError("Choose a country from the list.", field);
  return code;
}

export function saveTeam(slug: string | undefined, form: FormData, logo?: Upload): Team {
  const name = text(form, "name", { required: true, max: 60, label: "Name" });
  const s = snapshot();
  const existing = slug ? s.teams.find((t) => t.slug === slug) : undefined;
  if (!existing && s.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new FormError("A team with this name already exists.", "name");
  const newSlug = existing?.slug ?? uniqueSlug(slugify(name), (x) => s.teams.some((t) => t.slug === x));
  const countryCode = readCountry(form);
  const t: Team = {
    slug: newSlug,
    name,
    tag: text(form, "tag", { required: true, max: 4, label: "Tag" }).toUpperCase(),
    country: countryName(countryCode),
    countryCode,
    founded: int(form, "founded", { required: true, min: 1990, max: 2100, label: "Founded" })!,
    coach: text(form, "coach", { max: 60 }),
    logo: pickUpload(existing?.logo, logo),
  };
  transaction((tx) => tx.put("team", t.slug, t), actor(), existing ? "edit team" : "create team");
  return t;
}

/** Deleting a team keeps its players (as free agents) and their history. */
export function deleteTeam(slug: string) {
  const s = snapshot();
  if (s.matches.some((m) => m.teamA === slug || m.teamB === slug)) throw new FormError("This team has matches. Delete or reassign them first.");
  const today = Temporal.Now.plainDateISO().toString();
  transaction((tx) => {
    tx.remove("team", slug);
    tx.remove("ranking", slug);
    for (const p of s.players.filter((x) => x.team === slug)) {
      tx.put("player", p.slug, { ...p, team: "", status: "free" } satisfies Player);
      tx.put("transfer", transferId(today), { id: transferId(today), player: p.slug, date: today, from: slug, to: "", fromStatus: p.status ?? "active", toStatus: "free", note: "Team disbanded" } satisfies Transfer);
    }
  }, actor(), "delete team");
}

export const PLAYER_STATUSES: PlayerStatus[] = ["active", "benched", "free", "retired"];

let seq = 0;
const transferId = (date: string) => `${date}-${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, "0")}`;

/**
 * Save a player. Team and status come from the form; when either changes
 * (or a new player joins a team) a transfer is recorded on `moveDate`.
 * Free agents and retired players have no team.
 */
export function savePlayer(slug: string | undefined, form: FormData, photo?: Upload): Player {
  const s = snapshot();
  const nickname = text(form, "nickname", { required: true, max: 32, label: "Nickname" });
  const existing = slug ? s.players.find((p) => p.slug === slug) : undefined;
  if (slug && !existing) throw new FormError("This player no longer exists.");
  const newSlug = existing?.slug ?? uniqueSlug(slugify(nickname), (x) => s.players.some((p) => p.slug === x));

  let status = oneOf(form, "status", PLAYER_STATUSES, "Status");
  let team = text(form, "team");
  if (team && !s.teams.some((t) => t.slug === team)) throw new FormError("Choose a team from the list.", "team");
  if (status === "free" || status === "retired") team = "";
  else if (!team) throw new FormError(`An ${status} player needs a team. Choose one, or set the status to Free agent.`, "team");
  if (!team && status === "active") status = "free";

  const moveDate = optionalText(form, "moveDate", { max: 10 }) ?? Temporal.Now.plainDateISO().toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(moveDate)) throw new FormError("Move date must be a date.", "moveDate");
  const before = { team: existing?.team ?? "", status: existing?.status ?? (existing ? "active" : "free") } as const;
  const moved = before.team !== team || before.status !== status;

  const p: Player = {
    slug: newSlug,
    nickname,
    firstName: text(form, "firstName", { max: 40 }),
    lastName: text(form, "lastName", { max: 40 }),
    team,
    status,
    role: oneOf(form, "role", ROLES, "Role"),
    countryCode: readCountry(form, "countryCode", false) || (s.teams.find((t) => t.slug === team)?.countryCode ?? ""),
    age: int(form, "age", { min: 10, max: 60, label: "Age" }) ?? 0,
    ign: optionalText(form, "ign", { max: 64 }),
    steamId: optionalText(form, "steamId", { max: 32 }),
    photo: pickUpload(existing?.photo, photo),
    // "On team since" follows the latest move unless set explicitly.
    joined: optionalText(form, "joined", { max: 10 }) ?? (moved && team ? moveDate : existing?.joined),
  };
  if (p.joined && !/^\d{4}-\d{2}-\d{2}$/.test(p.joined)) throw new FormError("Join date must be a date.", "joined");
  if (p.steamId && !/^(7656\d{13}|\[U:1:\d+\]|\d{1,10})$/.test(p.steamId)) {
    throw new FormError("Steam ID must be a SteamID64 (7656…) or [U:1:123456].", "steamId");
  }
  transaction((tx) => {
    tx.put("player", p.slug, p);
    if (moved) {
      const id = transferId(moveDate);
      tx.put("transfer", id, { id, player: p.slug, date: moveDate, from: before.team, to: team, fromStatus: before.status, toStatus: status, note: optionalText(form, "moveNote", { max: 120 }) } satisfies Transfer);
    }
  }, actor(), existing ? (moved ? "move player" : "edit player") : "add player");
  return p;
}

/** Quick roster actions from lists: bench, activate, release, retire. */
export function setPlayerStatus(slug: string, status: PlayerStatus, team?: string) {
  const p = snapshot().players.find((x) => x.slug === slug);
  if (!p) throw new FormError("This player no longer exists.");
  const form = new FormData();
  // Re-submit the stored record; an unknown age (0) stays empty rather than failing validation.
  for (const [k, v] of Object.entries({ ...p, status, team: team ?? p.team, joined: "" })) {
    if (typeof v === "string") form.set(k, v);
    else if (typeof v === "number" && v > 0) form.set(k, String(v));
  }
  form.set("countryCode", p.countryCode ?? "");
  if (p.joined && (team ?? p.team) === p.team) form.set("joined", p.joined);
  return savePlayer(slug, form, undefined);
}

export function deletePlayer(slug: string) {
  const s = snapshot();
  const maps = s.matches.reduce((n, m) => n + m.maps.filter((x) => x.stats?.some((st) => st.player === slug)).length, 0);
  if (maps) throw new FormError(`This player has stats on ${maps} map${maps === 1 ? "" : "s"}. Set them to Retired instead, so their history stays.`);
  transaction((tx) => {
    tx.remove("player", slug);
    for (const t of s.transfers.filter((x) => x.player === slug)) tx.remove("transfer", t.id);
  }, actor(), "delete player");
}

export function deleteTransfer(id: string) {
  if (!snapshot().transfers.some((t) => t.id === id)) throw new FormError("That move was already removed.");
  transaction((tx) => tx.remove("transfer", id), actor(), "delete transfer");
}

/* ================================ Events ================================= */

export function saveEvent(slug: string | undefined, form: FormData, trophyImage?: Upload, eventLogo?: Upload): EsportsEvent {
  const name = text(form, "name", { required: true, max: 100, label: "Name" });
  const existing = slug ? snapshot().events.find((e) => e.slug === slug) : undefined;
  if (!existing && snapshot().events.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new FormError("An event with this name already exists.", "name");
  const newSlug = existing?.slug ?? uniqueSlug(slugify(name), (x) => snapshot().events.some((e) => e.slug === x));
  const startDate = isoDate(form, "startDate", "Start date");
  const endDate = isoDate(form, "endDate", "End date");
  if (endDate < startDate) throw new FormError("End date must be on or after the start date.", "endDate");
  const teamSlugs = new Set(snapshot().teams.map((t) => t.slug));
  const resnapshot = bool(form, "resnapshot");
  const rosterNow = (team: string) => snapshot().players.filter((p) => p.team === team).map((p) => p.slug);
  const playerSlugs = new Set(snapshot().players.map((p) => p.slug));
  // Prize rows: parallel fields, blank rows ignored.
  const places = form.getAll("prizePlace").map((x) => String(x).trim());
  const amounts = form.getAll("prizeAmount").map((x) => String(x).trim());
  const prizeTeams = form.getAll("prizeTeam").map((x) => String(x).trim());
  const prizes = places.flatMap((place, i) => {
    const raw = amounts[i] ?? "";
    const team = prizeTeams[i] ?? "";
    if (!place && !raw && !team) return [];
    if (!place) throw new FormError(`Prize row ${i + 1} needs a placement (e.g. 1st).`, "prizePlace");
    const amount = raw ? Number(raw.replace(/[^\d.]/g, "")) : 0;
    if (!Number.isFinite(amount) || amount < 0) throw new FormError(`Prize row ${i + 1}: the amount must be a number.`, "prizeAmount");
    if (team && !teamSlugs.has(team)) throw new FormError(`Prize row ${i + 1}: choose a team from the list.`, "prizeTeam");
    // Keep the roster that earned this placement; snapshot the current roster for new placements.
    const before = existing?.prizes.find((x) => x.place === place && x.team === team);
    const players = team ? (resnapshot || !before?.players ? rosterNow(team) : before.players) : undefined;
    return [{ place, prize: amount, team: team || undefined, players }];
  });
  const eventSlugs = new Set(snapshot().events.map((e) => e.slug));
  const swissStage = text(form, "swissStage", { max: 40 });
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
    mvp: playerSlugs.has(text(form, "mvp")) ? text(form, "mvp") : undefined,
    evps: form.getAll("evps").map(String).filter((x) => playerSlugs.has(x)),
    trophyImage: pickUpload(existing?.trophyImage, trophyImage),
    logo: pickUpload(existing?.logo, eventLogo),
    mapPool: MAP_POOL.filter((m) => form.getAll("mapPool").includes(m)),
    related: form.getAll("related").map(String).filter((x) => eventSlugs.has(x) && x !== newSlug),
    swiss: swissStage
      ? {
          stage: swissStage,
          wins: int(form, "swissWins", { required: true, min: 1, max: 5, label: "Wins to advance" })!,
          losses: int(form, "swissLosses", { required: true, min: 1, max: 5, label: "Losses to go out" })!,
        }
      : undefined,
  };
  transaction((tx) => {
    tx.put("event", ev.slug, ev);
    // Grouping is mutual: linking A to B also links B to A.
    for (const e of snapshot().events) {
      if (e.slug === ev.slug) continue;
      const linked = ev.related!.includes(e.slug);
      const has = e.related?.includes(ev.slug) ?? false;
      if (linked !== has) tx.put("event", e.slug, { ...e, related: linked ? [...(e.related ?? []), ev.slug] : (e.related ?? []).filter((x) => x !== ev.slug) });
    }
  }, actor(), existing ? "edit event" : "create event");
  return ev;
}

export function deleteEvent(slug: string) {
  if (snapshot().matches.some((m) => m.event === slug)) throw new FormError("This event has matches. Delete them first.");
  transaction((tx) => tx.remove("event", slug), actor(), "delete event");
}

/* ================================ Ranking ================================ */

/** Manual points adjustments, one per team (the rest of the ranking is computed). */
export function saveRankingAdjustments(form: FormData) {
  const s = snapshot();
  transaction((tx) => {
    for (const t of s.teams) {
      const adjust = int(form, `adjust_${t.slug}`, { min: -1000, max: 1000, label: `${t.name} adjustment` }) ?? 0;
      tx.put("ranking", t.slug, { team: t.slug, points: 0, change: 0, adjust } satisfies RankingEntry);
    }
  }, actor(), "adjust ranking");
}

/** Ranking maths constants (see src/data/elo.ts). */
export function saveRankingMath(form: FormData) {
  const w = (name: string, label: string) => num(form, name, { required: true, min: 0, max: 5, label })!;
  const elo: EloSettings = {
    start: int(form, "start", { required: true, min: 100, max: 5000, label: "Starting rating" })!,
    k: int(form, "k", { required: true, min: 1, max: 200, label: "Team K" })!,
    playerK: int(form, "playerK", { required: true, min: 0, max: 200, label: "Player K" })!,
    perf: int(form, "perf", { required: true, min: 0, max: 200, label: "Form weight" })!,
    marginStep: w("marginStep", "Margin bonus"),
    tier: { Major: w("tier_Major", "Major weight"), Premier: w("tier_Premier", "Premier weight"), Open: w("tier_Open", "Open weight"), Academy: w("tier_Academy", "Academy weight") },
    format: { bo1: w("bo1", "Bo1 weight"), bo3: w("bo3", "Bo3 weight"), bo5: w("bo5", "Bo5 weight") },
    minMatches: int(form, "minMatches", { required: true, min: 0, max: 50, label: "Matches to be ranked" })!,
  };
  const settings = { ...snapshot().settings, elo };
  transaction((tx) => tx.put("settings", "site", settings), actor(), "edit ranking maths");
}

/* ============================== Stats import ============================== */

const CSV_FIELDS: Record<string, string> = {
  kills: "k", k: "k", deaths: "d", d: "d", assists: "a", a: "a", adr: "adr", kast: "kast",
  hs: "hs", "hs%": "hs", rating: "rating", rws: "rws", fk: "fk", "first kills": "fk", fd: "fd",
  "first deaths": "fd", "clutches won": "cw", cw: "cw", "clutches played": "cp", cp: "cp",
  "utility damage": "ud", ud: "ud", "flash assists": "fa", fa: "fa",
};

/**
 * Accepts a header row plus one row per player (comma, tab or semicolon
 * separated), e.g. a Perfect World match export:
 *   player,kills,deaths,assists,adr,rws,rating,kast,hs,fk,fd,cw,cp,ud,fa
 * Players are matched by nickname, in-game name or Steam ID.
 */
function applyStatsCsv(form: FormData, csv: string, roster: Player[]) {
  const rows = csv.trim().split(/\r?\n/).filter(Boolean);
  const sep = rows[0]!.includes("\t") ? "\t" : rows[0]!.includes(";") ? ";" : ",";
  const header = rows[0]!.split(sep).map((h) => h.trim().toLowerCase());
  const nameCol = header.findIndex((h) => ["player", "name", "nickname", "steamid", "steam id"].includes(h));
  if (nameCol < 0) throw new FormError('CSV needs a "player" column.', "csv");
  const norm = (x: string) => x.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const unknown: string[] = [];
  for (const line of rows.slice(1)) {
    const cells = line.split(sep).map((c) => c.trim());
    const who = cells[nameCol] ?? "";
    const p = roster.find((x) => [x.nickname, x.ign ?? "", x.steamId ?? ""].some((v) => v && norm(v) === norm(who)));
    if (!p) {
      if (who) unknown.push(who);
      continue;
    }
    header.forEach((h, i) => {
      const key = CSV_FIELDS[h];
      if (key && cells[i] !== undefined && cells[i] !== "") form.set(`${key}_${p.slug}`, cells[i]!.replace("%", ""));
    });
  }
  if (unknown.length) throw new FormError(`Not on either roster: ${unknown.join(", ")}. Check nicknames or Steam IDs.`, "csv");
}

/* ================================ Seasons ================================= */

export function saveSeason(slug: string | undefined, form: FormData): Season {
  const name = text(form, "name", { required: true, max: 80, label: "Name" });
  const existing = slug ? snapshot().seasons.find((s) => s.slug === slug) : undefined;
  if (!existing && snapshot().seasons.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new FormError("A season with this name already exists.", "name");
  const newSlug = existing?.slug ?? uniqueSlug(slugify(name), (x) => snapshot().seasons.some((s) => s.slug === x));
  const startDate = isoDate(form, "startDate", "Start date");
  const endDate = isoDate(form, "endDate", "End date");
  if (endDate < startDate) throw new FormError("End date must be on or after the start date.", "endDate");
  const players = new Set(snapshot().players.map((p) => p.slug));
  const top: Season["top"] = [];
  for (let i = 0; i < 10; i++) {
    const player = text(form, `top_${i}`);
    if (!player) continue;
    if (!players.has(player)) throw new FormError(`Place ${i + 1}: unknown player.`);
    if (top.some((t) => t.player === player)) throw new FormError(`Place ${i + 1}: that player is already in the list.`);
    top.push({ player, note: optionalText(form, `note_${i}`, { max: 280 }) });
  }
  const tos = text(form, "teamOfSeason");
  const season: Season = {
    slug: newSlug,
    name,
    startDate,
    endDate,
    published: bool(form, "published"),
    top,
    teamOfSeason: tos && snapshot().teams.some((t) => t.slug === tos) ? tos : undefined,
    teamNote: optionalText(form, "teamNote", { max: 400 }),
  };
  transaction((tx) => tx.put("season", season.slug, season), actor(), existing ? "edit season" : "create season");
  return season;
}

export function deleteSeason(slug: string) {
  transaction((tx) => tx.remove("season", slug), actor(), "delete season");
}

/* ================================ Settings ================================ */

const NAV_KEYS = ["matches", "results", "events", "ranking", "players", "news", "season"] as const;

export function saveSettings(form: FormData, logos: { light?: Upload; dark?: Upload } = {}) {
  const current = snapshot().settings;
  const announcement = text(form, "announcement", { max: 200 });
  const href = text(form, "announcementHref", { max: 300 });
  if (href && !/^(\/|https:\/\/)/.test(href)) throw new FormError("Announcement link must start with / or https://.", "announcementHref");
  const featured = text(form, "featuredMatch");
  const settings: Settings = {
    rankingName: text(form, "rankingName", { required: true, max: 40, label: "Ranking name" }),
    seasonPageName: text(form, "seasonPageName", { required: true, max: 40, label: "Season page name" }),
    announcement: announcement ? { text: announcement, href: href || undefined } : undefined,
    featuredMatch: featured && snapshot().matches.some((m) => m.id === featured) ? featured : undefined,
    homeNewsCount: int(form, "homeNewsCount", { required: true, min: 1, max: 20 })!,
    homeResultsCount: int(form, "homeResultsCount", { required: true, min: 1, max: 30 })!,
    homeUpcomingCount: int(form, "homeUpcomingCount", { required: true, min: 1, max: 30 })!,
    footerText: text(form, "footerText", { required: true, max: 300, label: "Footer text" }),
    playerRankMinMaps: int(form, "playerRankMinMaps", { required: true, min: 0, max: 50 })!,
    nav: Object.fromEntries(NAV_KEYS.map((k) => [k, text(form, `nav_${k}`, { required: true, max: 30, label: "Menu label" })])) as Settings["nav"],
    navHidden: NAV_KEYS.filter((k) => bool(form, `navHide_${k}`)),
    footerLinks: lines(form, "footerLinks").map((line, i) => {
      const [label, href] = line.split("|").map((x) => x.trim());
      if (!label || !href || !/^(\/|https:\/\/)/.test(href)) throw new FormError(`Footer link ${i + 1} must look like "Teams | /teams/".`, "footerLinks");
      return { label, href };
    }),
    rails: {
      left: bool(form, "railLeft"),
      right: bool(form, "railRight"),
      awardTitle: text(form, "awardTitle", { required: true, max: 40, label: "Award heading" }),
      awardSubtitle: text(form, "awardSubtitle", { required: true, max: 40, label: "Award name" }),
      rankingTitle: text(form, "rankingTitle", { required: true, max: 40, label: "Ranking heading" }),
      activityTitle: text(form, "activityTitle", { required: true, max: 40, label: "Activity heading" }),
      nextMatch: bool(form, "boxNextMatch"),
      award: bool(form, "boxAward"),
      ranking: bool(form, "boxRanking"),
      events: bool(form, "boxEvents"),
      activity: bool(form, "boxActivity"),
      transfers: bool(form, "boxTransfers"),
      eventsTitle: text(form, "eventsTitle", { max: 40 }) || "Events",
      transfersTitle: text(form, "transfersTitle", { max: 40 }) || "Recent transfers",
      rankingCount: int(form, "rankingCount", { min: 1, max: 30, label: "Teams in the ranking box" }) ?? 5,
      transfersCount: int(form, "transfersCount", { min: 1, max: 20, label: "Moves in the transfers box" }) ?? 5,
    },
    intros: {
      matches: text(form, "introMatches", { max: 200 }),
      ranking: text(form, "introRanking", { max: 300 }),
      playerRank: text(form, "introPlayerRank", { max: 300 }),
      season: text(form, "introSeason", { max: 300 }),
    },
    footerLogoLight: pickUpload(current.footerLogoLight, logos.light),
    footerLogoDark: pickUpload(current.footerLogoDark, logos.dark),
    elo: current.elo,
  };
  transaction((tx) => tx.put("settings", "site", settings), actor(), "edit settings");
}
