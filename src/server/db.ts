import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Article, EsportsEvent, Feed, Match, Player, RankingEntry, Season, Settings, Team, Transfer } from "../data/types";
import { publish } from "./bus";
import { events as seedEvents, ranking as seedRanking, rankingUpdated as seedRankingUpdated, seasons as seedSeasons } from "./seed/events";
import { matches as seedMatches } from "./seed/matches";
import { articles as seedArticles } from "./seed/news";
import { players as seedPlayers, teams as seedTeams } from "./seed/teams";

/*
 * Persistence: a single SQLite file (Node's built-in `node:sqlite`, no native
 * dependency). Each record is stored as a JSON document keyed by (kind, id),
 * which keeps the schema aligned with the TypeScript types in src/data/types.ts.
 *
 * Reads go through an in-memory snapshot that is rebuilt after every write, so
 * page renders never hit the disk more than once per change.
 */

// Loaded at runtime so bundlers don't try to resolve the prefix-only builtin.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type Kind = "team" | "player" | "event" | "match" | "article" | "ranking" | "meta" | "feed" | "season" | "settings" | "transfer";

const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

type DB = InstanceType<typeof DatabaseSync>;
const g = globalThis as typeof globalThis & { __isecDb?: DB };

function open(): DB {
  const db = new DatabaseSync(join(DATA_DIR, "isec.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS docs (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (kind, id)
    );
    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL
    );
  `);
  // Older builds logged feed keys as audit targets; scrub them.
  db.exec("UPDATE audit SET target = 'feed:*' WHERE target LIKE 'feed:%' AND target <> 'feed:*'");
  return db;
}

export const db: DB = (g.__isecDb ??= open());

/* ------------------------------- Snapshot -------------------------------- */

export interface Snapshot {
  version: number;
  teams: Team[];
  players: Player[];
  events: EsportsEvent[];
  matches: Match[];
  articles: Article[];
  ranking: RankingEntry[];
  feeds: Feed[];
  seasons: Season[];
  transfers: Transfer[];
  settings: Settings;
  meta: { rankingUpdated: string };
}

/** Saved settings over the defaults, nested groups merged so new fields always exist. */
function mergeSettings(saved?: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    ...d,
    ...saved,
    nav: { ...d.nav, ...saved?.nav },
    rails: { ...d.rails, ...saved?.rails },
    intros: { ...d.intros, ...saved?.intros },
    navHidden: saved?.navHidden ?? d.navHidden,
    footerLinks: saved?.footerLinks ?? d.footerLinks,
  };
}

export const DEFAULT_SETTINGS: Settings = {
  rankingName: "School Teams Rank",
  seasonPageName: "Best of the Season",
  homeNewsCount: 5,
  homeResultsCount: 8,
  homeUpcomingCount: 8,
  footerText: "© 2026 ISEC. Counter-Strike is a trademark of Valve Corporation; ISEC is not affiliated with Valve.",
  playerRankMinMaps: 3,
  nav: { matches: "Matches", results: "Results", events: "Events", ranking: "Ranking", players: "Players", news: "News", season: "Best of the Season" },
  navHidden: [],
  footerLinks: [
    { label: "Teams", href: "/teams/" },
    { label: "Admin", href: "/admin/" },
  ],
  rails: { left: true, right: true, awardTitle: "Award by ISEC", awardSubtitle: "Player of the week", rankingTitle: "Ranking by ISEC", activityTitle: "Recent activity" },
  intros: {
    matches: "Times in your time zone.",
    ranking: "Points are Elo ratings worked out from every result: beat stronger teams, at bigger events, by more maps, to climb faster.",
    playerRank: "Overall blends rating with MVP, EVP and trophy wins.",
    season: "Top 10 players and the team of the season.",
  },
};

let cached: Snapshot | undefined;
let version = Date.now();

function all<T>(kind: Kind): T[] {
  const rows = db.prepare("SELECT data FROM docs WHERE kind = ? ORDER BY rowid").all(kind) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as T);
}

export function snapshot(): Snapshot {
  if (cached) return cached;
  ensureSeeded();
  const meta = all<{ key: string; value: string }>("meta");
  cached = {
    version,
    teams: all<Team>("team"),
    players: all<Player>("player"),
    events: all<EsportsEvent>("event"),
    matches: all<Match>("match"),
    articles: all<Article>("article"),
    ranking: all<RankingEntry>("ranking").sort((a, b) => b.points - a.points),
    feeds: all<Feed>("feed"),
    seasons: all<Season>("season").sort((a, b) => b.endDate.localeCompare(a.endDate)),
    // Newest first; same-day moves keep insertion order (ids are time-based).
    transfers: all<Transfer>("transfer").sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
    settings: mergeSettings(all<Settings>("settings")[0]),
    meta: { rankingUpdated: meta.find((m) => m.key === "rankingUpdated")?.value ?? "" },
  };
  return cached;
}

export const currentVersion = () => version;

/* -------------------------------- Writes --------------------------------- */

export interface Change {
  kind: Kind;
  id: string;
  op: "upsert" | "delete";
}

/** Kinds whose record ids are secrets (feed keys) and must never leave the server. */
const SECRET_IDS = new Set<Kind>(["feed"]);
const publicId = (c: Change) => (SECRET_IDS.has(c.kind) ? "*" : c.id);

function invalidate(changes: Change[]) {
  cached = undefined;
  version += 1;
  // The change stream is public (SSE): strip secret ids and de-duplicate.
  const seen = new Set<string>();
  const safe = changes
    .map((c) => ({ ...c, id: publicId(c) }))
    .filter((c) => !seen.has(`${c.kind}:${c.id}`) && seen.add(`${c.kind}:${c.id}`));
  publish({ version, changes: safe });
}

export interface Tx {
  put<T>(kind: Kind, id: string, data: T): void;
  remove(kind: Kind, id: string): void;
}

/** Run several writes atomically, audit them and broadcast them as one change set. */
export function transaction(fn: (tx: Tx) => void, actor = "system", action = "update", { audit = true } = {}) {
  const changes: Change[] = [];
  const put: Tx["put"] = (kind, id, data) => {
    db.prepare(
      `INSERT INTO docs (kind, id, data) VALUES (?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(kind, id, JSON.stringify(data));
    changes.push({ kind, id, op: "upsert" });
  };
  const remove = (kind: Kind, id: string) => {
    db.prepare("DELETE FROM docs WHERE kind = ? AND id = ?").run(kind, id);
    changes.push({ kind, id, op: "delete" });
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    fn({ put, remove });
    for (const c of audit ? changes : []) {
      db.prepare("INSERT INTO audit (actor, action, target) VALUES (?, ?, ?)").run(actor, action, `${c.kind}:${publicId(c)}`);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  if (changes.length) invalidate(changes);
}

export function auditLog(limit = 30) {
  return db.prepare("SELECT seq, at, actor, action, target FROM audit ORDER BY seq DESC LIMIT ?").all(limit) as {
    seq: number;
    at: string;
    actor: string;
    action: string;
    target: string;
  }[];
}

/* -------------------------------- Seeding -------------------------------- */

let seeded = false;

function ensureSeeded() {
  if (seeded) return;
  seeded = true;
  const row = db.prepare("SELECT COUNT(*) AS n FROM docs").get() as { n: number };
  // Set ISEC_SEED=false to start from an empty database instead of demo data.
  if (row.n > 0 || process.env.ISEC_SEED === "false") return;
  seedDemo();
}

/** Top 10 players by round-weighted rating over a date range (min 3 maps). */
function seasonTop(start: string, end: string) {
  const acc = new Map<string, { rating: number; rounds: number; maps: number }>();
  for (const m of seedMatches) {
    const day = m.start.slice(0, 10);
    if (m.status !== "completed" || day < start || day > end) continue;
    for (const map of m.maps) {
      if (!map.stats || map.scoreA === undefined) continue;
      const rounds = (map.scoreA ?? 0) + (map.scoreB ?? 0);
      for (const s of map.stats) {
        const a = acc.get(s.player) ?? { rating: 0, rounds: 0, maps: 0 };
        a.rating += s.rating * rounds;
        a.rounds += rounds;
        a.maps += 1;
        acc.set(s.player, a);
      }
    }
  }
  return [...acc]
    .filter(([, a]) => a.maps >= 3)
    .sort((x, y) => y[1].rating / y[1].rounds - x[1].rating / x[1].rounds)
    .slice(0, 10)
    .map(([player]) => ({ player }));
}

function seedDemo() {
  const insert = db.prepare("INSERT OR IGNORE INTO docs (kind, id, data) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (const t of seedTeams) insert.run("team", t.slug, JSON.stringify(t));
  for (const [i, p] of seedPlayers.entries()) {
    // Deterministic join dates between 2023 and 2026.
    const joined = `${2023 + (i % 4)}-${String(1 + ((i * 5) % 12)).padStart(2, "0")}-${String(1 + ((i * 7) % 27)).padStart(2, "0")}`;
    insert.run("player", p.slug, JSON.stringify({ ...p, joined, status: "active" }));
    const t: Transfer = { id: `${joined}-${String(i).padStart(3, "0")}`, player: p.slug, date: joined, from: "", to: p.team, fromStatus: "free", toStatus: "active" };
    insert.run("transfer", t.id, JSON.stringify(t));
  }
  const rosterOf = (team: string) => seedPlayers.filter((p) => p.team === team).map((p) => p.slug);
  for (const e of seedEvents) {
    // Snapshot the roster behind every decided placement so trophies follow players.
    const prizes = e.prizes.map((slot) => (slot.team ? { ...slot, players: rosterOf(slot.team) } : slot));
    insert.run("event", e.slug, JSON.stringify({ ...e, prizes }));
  }
  for (const season of seedSeasons) {
    insert.run("season", season.slug, JSON.stringify({ ...season, top: season.published ? seasonTop(season.startDate, season.endDate) : [] }));
  }
  for (const m of seedMatches) insert.run("match", m.id, JSON.stringify(m));
  for (const a of seedArticles) insert.run("article", a.slug, JSON.stringify(a));
  for (const r of seedRanking) insert.run("ranking", r.team, JSON.stringify(r));
  insert.run("meta", "rankingUpdated", JSON.stringify({ key: "rankingUpdated", value: seedRankingUpdated }));
  db.prepare("INSERT INTO audit (actor, action, target) VALUES ('system', 'seed', 'demo data')").run();
  db.exec("COMMIT");
}
