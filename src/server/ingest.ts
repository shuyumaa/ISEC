import { randomBytes } from "node:crypto";
import { mapDecided } from "../data";
import type {
  Feed,
  FeedPlayer,
  FeedState,
  KillEvent,
  MapName,
  Match,
  Player,
  PlayerMapStats,
  RoundEnd,
  Side,
  Team,
} from "../data/types";
import { snapshot, transaction } from "./db";
import { applyMapScore, normaliseMatch } from "./mutations";

/*
 * Game-server auto-sync — the same idea as HLTV's scorebot.
 *
 * Two sources, both pushed by the game itself (no polling):
 *  1. CS2 server logs over HTTP: on the tournament server run
 *       logaddress_add_http "https://<site>/api/ingest/cs2/<key>"
 *     The server POSTs batches of log lines (round ends, kills, damage, side
 *     assignments). This is the primary, most detailed feed.
 *  2. CS2 Game State Integration (GSI) from an observer / caster client:
 *     a gamestate_integration_isec.cfg that POSTs JSON to /api/ingest/gsi/<key>.
 *
 * Both are translated into the same match model the admin edits, through
 * applyMapScore, so maps close and series finish by exactly the same rules.
 */

const MAPS: Record<string, MapName> = {
  de_mirage: "Mirage",
  de_inferno: "Inferno",
  de_nuke: "Nuke",
  de_ancient: "Ancient",
  de_anubis: "Anubis",
  de_dust2: "Dust2",
  de_train: "Train",
};

export const newFeedKey = () => randomBytes(24).toString("base64url");

const freshState = (): FeedState => ({ round: 0, players: {}, roundDied: [], roundContrib: [] });

/* ------------------------------- Matching -------------------------------- */

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** SteamID64 or [U:1:n] → account id as a string. */
function accountId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const u = raw.match(/\[U:\d:(\d+)\]/);
  if (u) return u[1];
  if (/^7656\d{13}$/.test(raw)) return String(BigInt(raw) - 76561197960265728n);
  if (/^\d+$/.test(raw)) return raw;
  return undefined;
}

function teamSide(m: Match, name: string): "A" | "B" | undefined {
  const n = norm(name);
  if (!n) return undefined;
  const s = snapshot();
  const fits = (t?: Team) => !!t && (norm(t.name) === n || norm(t.tag) === n || norm(t.slug) === n || n.includes(norm(t.name)));
  if (fits(s.teams.find((t) => t.slug === m.teamA))) return "A";
  if (fits(s.teams.find((t) => t.slug === m.teamB))) return "B";
  return undefined;
}

function findPlayer(m: Match, name: string, steam: string | undefined): Player | undefined {
  const roster = snapshot().players.filter((p) => p.team === m.teamA || p.team === m.teamB);
  const id = accountId(steam);
  if (id) {
    const bySteam = roster.find((p) => accountId(p.steamId) === id);
    if (bySteam) return bySteam;
  }
  const n = norm(name);
  return roster.find((p) => norm(p.ign ?? "") === n || norm(p.nickname) === n);
}

/* --------------------------- Applying to a match -------------------------- */

interface Ctx {
  m: Match;
  state: FeedState;
  scoreChanged: boolean;
  unmatched: Set<string>;
  hp: Map<string, number>;
}

function mapIndexFor(m: Match, mapName: MapName): number {
  let i = m.maps.findIndex((x) => x.map === mapName && !mapDecided(x));
  if (i < 0) i = m.maps.findIndex((x) => !mapDecided(x));
  if (i >= 0) m.maps[i]!.map = mapName;
  return i;
}

function currentIndex(ctx: Ctx): number {
  const { m, state } = ctx;
  const live = m.maps.findIndex((x) => x.live);
  if (live >= 0) return live;
  return state.mapName ? mapIndexFor(m, state.mapName as MapName) : m.maps.findIndex((x) => !mapDecided(x));
}

function setScore(ctx: Ctx, a: number, b: number) {
  const i = currentIndex(ctx);
  if (i < 0) return;
  const map = ctx.m.maps[i]!;
  if (map.scoreA === a && map.scoreB === b && map.live) return;
  applyMapScore(ctx.m, i, a, b);
  ctx.scoreChanged = true;
}

function player(ctx: Ctx, name: string, steam: string | undefined): FeedPlayer {
  const p = findPlayer(ctx.m, name, steam);
  const key = p ? p.slug : `name:${name}`;
  if (!p && name) ctx.unmatched.add(name);
  return (ctx.state.players[key] ??= { key, slug: p?.slug, name: p?.nickname ?? name, kills: 0, deaths: 0, assists: 0, damage: 0, headshots: 0, kastRounds: 0 });
}

/** Learn which team is on CT from a known player's side. */
function learnSide(ctx: Ctx, fp: FeedPlayer, side: Side) {
  if (!fp.slug) return;
  const p = snapshot().players.find((x) => x.slug === fp.slug);
  const team = p?.team === ctx.m.teamA ? "A" : p?.team === ctx.m.teamB ? "B" : undefined;
  if (!team) return;
  ctx.state.ct = side === "CT" ? team : team === "A" ? "B" : "A";
}

function writeStats(ctx: Ctx, i = currentIndex(ctx)) {
  const map = i >= 0 ? ctx.m.maps[i] : undefined;
  if (!map) return;
  const rounds = Math.max(1, (map.scoreA ?? 0) + (map.scoreB ?? 0));
  const stats: PlayerMapStats[] = Object.values(ctx.state.players)
    .filter((p) => p.slug)
    .map((p) => {
      const kpr = p.kills / rounds;
      const dpr = p.deaths / rounds;
      const adr = Number((p.damage / rounds).toFixed(1));
      const kast = Number(((p.kastRounds / rounds) * 100).toFixed(1));
      return {
        player: p.slug!,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        adr,
        kast: Math.min(100, kast),
        hs: p.kills ? Number(((p.headshots / p.kills) * 100).toFixed(1)) : 0,
        rating: Number(((kpr / 0.68) * 0.45 + ((1 - dpr) / 0.32) * 0.25 + (adr / 76) * 0.3).toFixed(2)),
      };
    });
  if (stats.length) map.stats = stats;
}

const sideOf = (raw: string): Side | undefined => (raw === "CT" ? "CT" : raw === "TERRORIST" ? "T" : undefined);

function roundEnd(ctx: Ctx, winnerSide: Side, how: RoundEnd, ct: number, t: number) {
  const { state } = ctx;
  // Names not set on the server and no known player seen yet: assume A starts CT.
  state.ct ??= "A";
  const a = state.ct === "A" ? ct : t;
  const b = state.ct === "A" ? t : ct;
  const winner: "A" | "B" = winnerSide === "CT" ? state.ct : state.ct === "A" ? "B" : "A";

  // KAST: kill, assist, survived (or traded — not tracked) this round.
  for (const p of Object.values(state.players)) {
    if (state.roundContrib.includes(p.key) || !state.roundDied.includes(p.key)) p.kastRounds += 1;
  }

  const i = currentIndex(ctx);
  setScore(ctx, a, b);
  const map = i >= 0 ? ctx.m.maps[i] : undefined;
  if (map) {
    const n = a + b;
    map.rounds = [...(map.rounds ?? []).filter((r) => r.n < n), { n, winner, side: winnerSide, how }];
    if (n === 1) map.startSideA = state.ct === "A" ? "CT" : "T";
  }
  state.round = a + b;
  // Side swap at half time (MR12) and every 3 rounds in overtime (MR3).
  const total = a + b;
  if (total === 12 || (total > 24 && (total - 24) % 3 === 0)) state.ct = state.ct === "A" ? "B" : "A";
  writeStats(ctx, i);
}

/* ------------------------------ CS2 log lines ----------------------------- */

const ENTITY = String.raw`"(.+?)<(\d*)><([^>]*)><([^>]*)>"`;
const POS = String.raw`(?:\[[^\]]*\] )?`;
const RE = {
  prefix: /^(?:L\s+)?\d{2}\/\d{2}\/\d{4} - \d{2}:\d{2}:\d{2}(?:\.\d+)?(?: -|:)\s*/,
  mapStarted: /^(?:Started map|Loading map) "([^"]+)"/,
  matchStart: /^World triggered "Match_Start" on "([^"]+)"/,
  roundStart: /^World triggered "Round_Start"/,
  teamPlaying: /^(?:MatchStatus: )?Team playing "(CT|TERRORIST)": (.+)$/,
  teamTriggered: /^Team "(CT|TERRORIST)" triggered "([^"]+)" \(CT "(\d+)"\) \(T "(\d+)"\)/,
  status: /^MatchStatus: Score: (\d+):(\d+) on map "([^"]+)"/,
  killed: new RegExp(`^${ENTITY} ${POS}killed ${ENTITY} ${POS}with "([^"]+)"(?: \\(([^)]*)\\))?`),
  attacked: new RegExp(`^${ENTITY} ${POS}attacked ${ENTITY} ${POS}with "([^"]+)" \\(damage "(\\d+)"\\)`),
  assisted: new RegExp(`^${ENTITY} (?:flash-)?assisted killing ${ENTITY}`),
};

function howFrom(event: string): RoundEnd {
  const e = event.toLowerCase();
  if (e.includes("bombed")) return "bomb";
  if (e.includes("defused")) return "defuse";
  if (e.includes("saved")) return "time";
  return "elimination";
}

function handleLine(ctx: Ctx, raw: string) {
  const line = raw.replace(RE.prefix, "").trim();
  if (!line) return;
  let r: RegExpMatchArray | null;

  if ((r = line.match(RE.matchStart))) {
    const name = MAPS[r[1]!];
    if (!name) return;
    ctx.state = { ...freshState(), mapName: name, ct: ctx.state.ct };
    const i = mapIndexFor(ctx.m, name);
    if (i >= 0) {
      const map = ctx.m.maps[i]!;
      delete map.rounds;
      delete map.kills;
      delete map.stats;
      applyMapScore(ctx.m, i, 0, 0);
      ctx.scoreChanged = true;
    }
    return;
  }
  if ((r = line.match(RE.mapStarted))) {
    const name = MAPS[r[1]!];
    if (name) ctx.state.mapName = name;
    return;
  }
  if (RE.roundStart.test(line)) {
    ctx.state.roundDied = [];
    ctx.state.roundContrib = [];
    ctx.hp.clear();
    return;
  }
  if ((r = line.match(RE.teamPlaying))) {
    const team = teamSide(ctx.m, r[2]!);
    if (team) ctx.state.ct = r[1] === "CT" ? team : team === "A" ? "B" : "A";
    return;
  }
  if ((r = line.match(RE.teamTriggered))) {
    roundEnd(ctx, r[1] === "CT" ? "CT" : "T", howFrom(r[2]!), Number(r[3]), Number(r[4]));
    return;
  }
  if ((r = line.match(RE.status))) {
    const name = MAPS[r[3]!];
    if (name) ctx.state.mapName = name;
    ctx.state.ct ??= "A";
    const ct = Number(r[1]);
    const t = Number(r[2]);
    setScore(ctx, ctx.state.ct === "A" ? ct : t, ctx.state.ct === "A" ? t : ct);
    return;
  }
  if ((r = line.match(RE.killed))) {
    const [, aName, , aSteam, aTeam, vName, , vSteam, vTeam, weapon, mods] = r;
    const aSide = sideOf(aTeam!);
    const vSide = sideOf(vTeam!);
    if (!aSide || !vSide) return;
    const attacker = player(ctx, aName!, aSteam);
    const victim = player(ctx, vName!, vSteam);
    learnSide(ctx, attacker, aSide);
    learnSide(ctx, victim, vSide);
    victim.deaths += 1;
    ctx.state.roundDied.push(victim.key);
    const headshot = /headshot/.test(mods ?? "");
    if (aSide !== vSide) {
      attacker.kills += 1;
      if (headshot) attacker.headshots += 1;
      ctx.state.roundContrib.push(attacker.key);
    }
    const i = currentIndex(ctx);
    const map = i >= 0 ? ctx.m.maps[i] : undefined;
    if (map) {
      const kill: KillEvent = {
        at: new Date().toISOString(),
        round: ctx.state.round + 1,
        attacker: attacker.name,
        attackerSide: aSide,
        victim: victim.name,
        victimSide: vSide,
        weapon: weapon!,
        headshot,
      };
      map.kills = [kill, ...(map.kills ?? [])].slice(0, 15);
    }
    return;
  }
  if ((r = line.match(RE.attacked))) {
    const [, aName, , aSteam, aTeam, vName, , vSteam, vTeam, , dmg] = r;
    if (aTeam === vTeam) return; // team damage doesn't count
    const attacker = player(ctx, aName!, aSteam);
    const victimKey = player(ctx, vName!, vSteam).key;
    const hp = ctx.hp.get(victimKey) ?? 100;
    const real = Math.min(Number(dmg), hp); // ADR counts damage up to remaining health
    ctx.hp.set(victimKey, hp - real);
    attacker.damage += real;
    return;
  }
  if ((r = line.match(RE.assisted))) {
    const assister = player(ctx, r[1]!, r[3]);
    assister.assists += 1;
    ctx.state.roundContrib.push(assister.key);
  }
}

/* ---------------------------------- GSI ---------------------------------- */

interface GsiTeam {
  score?: number;
  name?: string;
}
interface Gsi {
  map?: {
    name?: string;
    phase?: string;
    round?: number;
    team_ct?: GsiTeam;
    team_t?: GsiTeam;
    round_wins?: Record<string, string>;
  };
  allplayers?: Record<string, { name?: string; team?: string; match_stats?: { kills?: number; deaths?: number; assists?: number } }>;
}

function handleGsi(ctx: Ctx, body: Gsi) {
  const map = body.map;
  if (!map?.name) return;
  const name = MAPS[map.name];
  if (!name) return;
  if (name !== ctx.state.mapName) ctx.state = { ...freshState(), mapName: name };
  if (map.phase === "warmup") return;

  const ctTeam = map.team_ct?.name ? teamSide(ctx.m, map.team_ct.name) : undefined;
  const tTeam = map.team_t?.name ? teamSide(ctx.m, map.team_t.name) : undefined;
  ctx.state.ct = ctTeam ?? (tTeam ? (tTeam === "A" ? "B" : "A") : (ctx.state.ct ?? "A"));

  const ct = map.team_ct?.score ?? 0;
  const t = map.team_t?.score ?? 0;
  const i = mapIndexFor(ctx.m, name);
  setScore(ctx, ctx.state.ct === "A" ? ct : t, ctx.state.ct === "A" ? t : ct);

  const target = i >= 0 ? ctx.m.maps[i] : undefined;
  if (target && map.round_wins) {
    // round_wins values look like "ct_win_elimination", "t_win_bomb", "ct_win_defuse", "ct_win_time".
    // GSI reports sides, not teams, so resolve each round through the half the round was played in.
    const startCt = target.startSideA === "T" ? "B" : "A";
    target.rounds = Object.entries(map.round_wins)
      .map(([n, v]) => {
        const round = Number(n);
        const side: Side = v.startsWith("ct") ? "CT" : "T";
        const swaps = round > 12 ? 1 + (round > 24 ? Math.floor((round - 25) / 3) + 1 : 0) : 0;
        const ctTeamThen = swaps % 2 === 0 ? startCt : startCt === "A" ? "B" : "A";
        const winner: "A" | "B" = side === "CT" ? ctTeamThen : ctTeamThen === "A" ? "B" : "A";
        const how: RoundEnd = v.includes("bomb") ? "bomb" : v.includes("defuse") ? "defuse" : v.includes("time") ? "time" : "elimination";
        return { n: round, winner, side, how };
      })
      .sort((a, b) => a.n - b.n);
  }

  if (target && body.allplayers) {
    const rounds = Math.max(1, (target.scoreA ?? 0) + (target.scoreB ?? 0));
    const stats: PlayerMapStats[] = [];
    for (const [steam, p] of Object.entries(body.allplayers)) {
      const found = findPlayer(ctx.m, p.name ?? "", steam);
      if (!found) {
        if (p.name) ctx.unmatched.add(p.name);
        continue;
      }
      const s = p.match_stats ?? {};
      const kills = s.kills ?? 0;
      const deaths = s.deaths ?? 0;
      const prev = target.stats?.find((x) => x.player === found.slug);
      stats.push({
        player: found.slug,
        kills,
        deaths,
        assists: s.assists ?? 0,
        adr: prev?.adr ?? 0,
        kast: prev?.kast ?? 0,
        hs: prev?.hs ?? 0,
        rating: Number((((kills / rounds) / 0.68) * 0.7 + ((1 - deaths / rounds) / 0.32) * 0.3).toFixed(2)),
      });
    }
    if (stats.length) target.stats = stats;
  }
}

/* --------------------------------- Entry --------------------------------- */

export type IngestResult = { ok: true; changed: boolean } | { ok: false; status: number; error: string };

export function ingest(key: string, source: "cs2-log" | "gsi", payload: string): IngestResult {
  const s = snapshot();
  const feed = s.feeds.find((f) => f.key === key);
  if (!feed) return { ok: false, status: 404, error: "Unknown feed key" };
  const original = s.matches.find((m) => m.id === feed.match);
  if (!original) return { ok: false, status: 410, error: "Match no longer exists" };
  if (original.status === "completed") return { ok: true, changed: false };

  const ctx: Ctx = {
    m: structuredClone(original),
    state: structuredClone(feed.state ?? freshState()),
    scoreChanged: false,
    unmatched: new Set(original.feed?.unmatched ?? []),
    hp: new Map(),
  };

  if (source === "cs2-log") {
    for (const line of payload.split(/\r?\n/)) handleLine(ctx, line);
  } else {
    let body: Gsi;
    try {
      body = JSON.parse(payload) as Gsi;
    } catch {
      return { ok: false, status: 400, error: "Invalid JSON" };
    }
    handleGsi(ctx, body);
  }

  const now = new Date().toISOString();
  ctx.m.feed = { lastSeenAt: now, source, unmatched: [...ctx.unmatched].slice(0, 20) };
  normaliseMatch(ctx.m);
  const nextFeed: Feed = { ...feed, lastSeenAt: now, state: ctx.state };
  transaction(
    (tx) => {
      tx.put("feed", feed.key, nextFeed);
      tx.put("match", ctx.m.id, ctx.m);
    },
    "server",
    "live feed update",
    // Only score changes go to the activity log; kills and heartbeats don't.
    { audit: ctx.scoreChanged },
  );
  return { ok: true, changed: ctx.scoreChanged };
}

export function createFeed(matchId: string): Feed {
  const feed: Feed = { key: newFeedKey(), match: matchId, createdAt: new Date().toISOString() };
  transaction((tx) => {
    // One feed per match: replace any previous key.
    for (const f of snapshot().feeds.filter((x) => x.match === matchId)) tx.remove("feed", f.key);
    tx.put("feed", feed.key, feed);
  }, "admin", "connect server feed");
  return feed;
}

export function revokeFeed(matchId: string) {
  transaction((tx) => {
    for (const f of snapshot().feeds.filter((x) => x.match === matchId)) tx.remove("feed", f.key);
  }, "admin", "disconnect server feed");
}

export const feedFor = (matchId: string) => snapshot().feeds.find((f) => f.match === matchId);
