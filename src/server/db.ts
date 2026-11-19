import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Article, EsportsEvent, Match, Player, RankingEntry, Team } from "../data/types";
import { publish } from "./bus";
import { events as seedEvents, ranking as seedRanking, rankingUpdated as seedRankingUpdated } from "./seed/events";
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

export type Kind = "team" | "player" | "event" | "match" | "article" | "ranking" | "meta";

const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
mkdirSync(DATA_DIR, { recursive: true });

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
  meta: { rankingUpdated: string };
}

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

function invalidate(changes: Change[]) {
  cached = undefined;
  version += 1;
  publish({ version, changes });
}

export interface Tx {
  put<T>(kind: Kind, id: string, data: T): void;
  remove(kind: Kind, id: string): void;
}

/** Run several writes atomically, audit them and broadcast them as one change set. */
export function transaction(fn: (tx: Tx) => void, actor = "system", action = "update") {
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
    for (const c of changes) {
      db.prepare("INSERT INTO audit (actor, action, target) VALUES (?, ?, ?)").run(actor, action, `${c.kind}:${c.id}`);
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

function seedDemo() {
  const insert = db.prepare("INSERT OR IGNORE INTO docs (kind, id, data) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  for (const t of seedTeams) insert.run("team", t.slug, JSON.stringify(t));
  for (const p of seedPlayers) insert.run("player", p.slug, JSON.stringify(p));
  for (const e of seedEvents) insert.run("event", e.slug, JSON.stringify(e));
  for (const m of seedMatches) insert.run("match", m.id, JSON.stringify(m));
  for (const a of seedArticles) insert.run("article", a.slug, JSON.stringify(a));
  for (const r of seedRanking) insert.run("ranking", r.team, JSON.stringify(r));
  insert.run("meta", "rankingUpdated", JSON.stringify({ key: "rankingUpdated", value: seedRankingUpdated }));
  db.prepare("INSERT INTO audit (actor, action, target) VALUES ('system', 'seed', 'demo data')").run();
  db.exec("COMMIT");
}
