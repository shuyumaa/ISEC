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
}

export type EventStatus = "ongoing" | "upcoming" | "completed";
export type EventTier = "Major" | "Premier" | "Open" | "Academy";

export interface PrizeSlot {
  place: string;
  prize: number;
  team?: string; // team slug, once decided
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
}

export interface RankingEntry {
  team: string;
  points: number;
  /** Positive = moved up since last ranking. */
  change: number;
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
