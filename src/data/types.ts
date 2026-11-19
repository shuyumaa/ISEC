/**
 * Domain model for ISEC. Everything the site renders comes from these types,
 * so swapping the mock modules in this folder for a real API/database only
 * requires returning the same shapes.
 */

export type MapName =
  | "Mirage"
  | "Inferno"
  | "Nuke"
  | "Ancient"
  | "Anubis"
  | "Dust2"
  | "Train";

export interface Team {
  slug: string;
  name: string;
  /** 2–4 letter tag used in compact views and the monogram mark. */
  tag: string;
  country: string;
  /** ISO 3166-1 alpha-2, used only as text — no flag colours in a B/W system. */
  countryCode: string;
  founded: number;
  coach: string;
  /** Uploaded logo (file name under /media/u/). */
  logo?: string;
}

export type Role = "IGL" | "AWP" | "Entry" | "Support" | "Lurker" | "Rifler";

export interface Player {
  slug: string;
  nickname: string;
  firstName: string;
  lastName: string;
  team: string; // team slug
  role: Role;
  countryCode: string;
  age: number;
  /** Name shown on the game server, if different from the nickname (used by the live feed). */
  ign?: string;
  /** SteamID64 or [U:1:n] — the most reliable way to match server log lines to a player. */
  steamId?: string;
  /** Uploaded portrait (file name under /media/u/). */
  photo?: string;
  /** Date the player joined the current team (YYYY-MM-DD). */
  joined?: string;
}

export type EventStatus = "ongoing" | "upcoming" | "completed";
export type EventTier = "Major" | "Premier" | "Open" | "Academy";

export interface PrizeSlot {
  place: string;
  prize: number;
  team?: string; // team slug, once decided
  /** Roster that earned the placement (snapshot, so trophies follow players). */
  players?: string[];
}

export interface EsportsEvent {
  slug: string;
  name: string;
  tier: EventTier;
  status: EventStatus;
  /** Plain ISO dates (YYYY-MM-DD) – events are calendar-bound, not instant-bound. */
  startDate: string;
  endDate: string;
  /** IANA zone the event is played in; all its match times are bound to it. */
  timeZone: string;
  location: string;
  online: boolean;
  prizePool: number;
  teams: string[]; // team slugs
  format: string[];
  prizes: PrizeSlot[];
  winner?: string;
  /** Event MVP (player slug) and EVPs (Exceptionally Valuable Players). */
  mvp?: string;
  evps?: string[];
  /** Uploaded photo of the physical trophy (file name under /media/u/). */
  trophyImage?: string;
}

export type MatchStatus = "live" | "upcoming" | "completed";
export type Side = "CT" | "T";

export interface PlayerMapStats {
  player: string; // player slug
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
  kast: number; // percentage 0–100
  hs: number; // headshot percentage 0–100
  rating: number;
  /* Perfect World (完美世界) style extras — optional, counted when present. */
  rws?: number;
  firstKills?: number;
  firstDeaths?: number;
  clutchesWon?: number;
  clutchesPlayed?: number;
  utilityDamage?: number;
  flashAssists?: number;
}

export type RoundEnd = "elimination" | "bomb" | "defuse" | "time";

export interface RoundResult {
  n: number;
  /** Which team won the round (A/B) and on which side they played it. */
  winner: "A" | "B";
  side: Side;
  how: RoundEnd;
}

export interface KillEvent {
  at: string; // ISO instant
  round: number;
  attacker: string; // display name
  attackerSide: Side;
  victim: string;
  victimSide: Side;
  weapon: string;
  headshot: boolean;
}

export interface MapResult {
  map: MapName;
  pickedBy?: string; // team slug, undefined for decider
  /** Rounds won by team A / team B. Undefined when the map hasn't started. */
  scoreA?: number;
  scoreB?: number;
  /** First-half side for team A. */
  startSideA?: Side;
  halfA?: [number, number];
  halfB?: [number, number];
  live?: boolean;
  stats?: PlayerMapStats[];
  /** Round-by-round history (filled by the live server feed). */
  rounds?: RoundResult[];
  /** Most recent kills on this map, newest first (live feed). */
  kills?: KillEvent[];
}

export interface VetoStep {
  team?: string;
  action: "removed" | "picked" | "left over";
  map: MapName;
}

export interface Match {
  id: string;
  event: string; // event slug
  stage: string;
  bestOf: 1 | 3 | 5;
  status: MatchStatus;
  /** Wall-clock start in the event's zone, e.g. "2026-11-19T18:00". */
  start: string;
  teamA: string;
  teamB: string;
  /** Maps won (series score). */
  seriesA: number;
  seriesB: number;
  maps: MapResult[];
  veto: VetoStep[];
  stars: 0 | 1 | 2 | 3;
  /** Live server feed status, when a game server is connected to this match. */
  feed?: { lastSeenAt: string; source: "cs2-log" | "gsi"; unmatched?: string[] };
}

/** A connected game-server feed. The key is the secret in the ingest URL. */
export interface Feed {
  key: string;
  match: string;
  createdAt: string;
  lastSeenAt?: string;
  /** Live parser state so a restart resumes mid-map. */
  state?: FeedState;
}

export interface FeedState {
  mapName?: string;
  /** Which team (A/B) currently plays CT. */
  ct?: "A" | "B";
  round: number;
  players: Record<string, FeedPlayer>;
  roundDied: string[];
  roundContrib: string[];
}

export interface FeedPlayer {
  key: string; // player slug or "name:<ign>"
  slug?: string;
  name: string;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  headshots: number;
  kastRounds: number;
}

/** A season and its end-of-season awards ("Best of the Season"). */
export interface Season {
  slug: string;
  name: string;
  startDate: string;
  endDate: string;
  /** Awards are shown publicly only once published. */
  published: boolean;
  top: { player: string; note?: string }[]; // ordered, #1 first, up to 10
  teamOfSeason?: string;
  teamNote?: string;
}

/** Site-wide settings editable in the admin. */
export interface Settings {
  rankingName: string;
  seasonPageName: string;
  announcement?: { text: string; href?: string };
  /** Pin a match to the top of the home page instead of the automatic pick. */
  featuredMatch?: string;
  homeNewsCount: number;
  homeResultsCount: number;
  homeUpcomingCount: number;
  footerText: string;
  /** Minimum maps for a player to appear in the player rank. */
  playerRankMinMaps: number;
  /** Top-bar links: label per section, and sections hidden from the bar. */
  nav: Record<NavKey, string>;
  navHidden: NavKey[];
  footerLinks: { label: string; href: string }[];
  /** Rail headings and visibility. */
  rails: { left: boolean; right: boolean; awardTitle: string; awardSubtitle: string; rankingTitle: string; activityTitle: string };
  /** Short intro lines under page headings. */
  intros: { matches: string; ranking: string; playerRank: string; season: string };
  /** Uploaded footer logo overrides (file names under /media/u/). */
  footerLogoLight?: string;
  footerLogoDark?: string;
  /** Ranking maths constants (src/data/elo.ts); missing values use the defaults. */
  elo?: Partial<Omit<EloSettings, "tier" | "format">> & { tier?: Partial<EloSettings["tier"]>; format?: Partial<EloSettings["format"]> };
}

export interface EloSettings {
  /** Rating every new team and player starts on. */
  start: number;
  /** Team K-factor: the most a single series can move a team (before weights). */
  k: number;
  /** Player K-factor for the team-result part of a map. */
  playerK: number;
  /** Player form part: points per 1.00 of HLTV rating above/below 1.00. */
  perf: number;
  /** Extra K per extra map of winning margin (2–0 vs 2–1). */
  marginStep: number;
  tier: Record<EventTier, number>;
  format: { bo1: number; bo3: number; bo5: number };
  /** Completed series a team needs before it appears in the ranking. */
  minMatches: number;
}

export type NavKey = "matches" | "results" | "events" | "ranking" | "players" | "news" | "season";

export interface RankingEntry {
  team: string;
  /** Ranking points = Elo + adjust (computed, see src/data/elo.ts). */
  points: number;
  /** Positions gained over the last 7 days. */
  change: number;
  /** Manual points adjustment set by an admin (the only stored part). */
  adjust?: number;
}

export interface Article {
  slug: string;
  title: string;
  summary: string;
  category: "Announcement" | "Interview" | "Recap" | "Analysis" | "Roster";
  author: string;
  published: string; // ISO date
  readMinutes: number;
  body: string[];
  related?: { teams?: string[]; event?: string };
}
