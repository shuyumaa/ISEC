import { randomUUID } from "node:crypto";
import type { PlayerStatus, RosterRequest } from "../data/types";
import { actor } from "./actor";
import { snapshot, transaction } from "./db";
import { FormError, optionalText, text } from "./forms";
import { PLAYER_STATUSES, movePlayerInLineup, savePlayer, saveTeam, setPlayerStatus } from "./mutations";

/*
 * Team panel actions. Every function takes the signed-in account's team slug
 * and refuses anything outside that team, so a team account can only change
 * its own profile and players. Moves that affect other teams or the event
 * list become requests an admin decides on.
 */

type Upload = string | null | undefined;

function ownTeam(team: string | undefined) {
  if (!team || !snapshot().teams.some((t) => t.slug === team)) throw new FormError("Your account isn't linked to a team any more. Ask an ISEC admin.");
  return team;
}

function ownPlayer(team: string, slug: string) {
  const p = snapshot().players.find((x) => x.slug === slug);
  if (!p || p.team !== team) throw new FormError("That player isn't on your team.");
  return p;
}

export function teamSaveProfile(team: string | undefined, form: FormData, logo: Upload) {
  return saveTeam(ownTeam(team), form, logo);
}

/**
 * Add or edit one of the team's players. Team and status can't be changed
 * here (that's a request); a new player joins the team as active.
 */
export function teamSavePlayer(team: string | undefined, slug: string | undefined, form: FormData, photo: Upload) {
  const t = ownTeam(team);
  const existing = slug ? ownPlayer(t, slug) : undefined;
  const safe = new FormData();
  for (const [k, v] of form) if (k !== "team" && k !== "status" && k !== "moveDate" && k !== "moveNote") safe.append(k, v);
  safe.set("team", t);
  safe.set("status", existing?.status === "benched" ? "benched" : "active");
  if (!existing) safe.set("moveNote", "Added by the team");
  return savePlayer(existing?.slug, safe, photo);
}

/** Bench or bring back one of the team's own players (an internal roster call). */
export function teamSetBench(team: string | undefined, slug: string, benched: boolean) {
  const t = ownTeam(team);
  ownPlayer(t, slug);
  return setPlayerStatus(slug, benched ? "benched" : "active");
}

/** Reorder the team's own lineup. */
export function teamMovePlayer(team: string | undefined, slug: string, dir: "up" | "down") {
  const t = ownTeam(team);
  ownPlayer(t, slug);
  movePlayerInLineup(t, slug, dir);
}

/* -------------------------------- Requests ------------------------------- */

const pendingFor = (team: string) => snapshot().requests.filter((r) => r.team === team && r.status === "pending");

function save(r: RosterRequest, action: string) {
  transaction((tx) => tx.put("request", r.id, r), actor(), action);
  return r;
}

/**
 * Request a move:
 *  - out: one of our players to free agent, retired, or another team;
 *  - in: sign a free agent or another team's player to us.
 */
export function requestTransfer(team: string | undefined, form: FormData) {
  const t = ownTeam(team);
  const s = snapshot();
  const slug = text(form, "player", { required: true, label: "Player" });
  const p = s.players.find((x) => x.slug === slug);
  if (!p) throw new FormError("Choose a player from the list.", "player");
  const direction = text(form, "direction", { required: true });
  let toTeam = "";
  let toStatus: PlayerStatus = "active";
  if (direction === "in") {
    if (p.team === t) throw new FormError("That player is already on your team.", "player");
    if (p.status === "retired") throw new FormError("Retired players can't be signed.", "player");
    toTeam = t;
  } else {
    if (p.team !== t) throw new FormError("You can only move your own players.", "player");
    const to = text(form, "to", { required: true, label: "Destination" });
    if (to === "free" || to === "retired") {
      toStatus = to as PlayerStatus;
    } else {
      if (!s.teams.some((x) => x.slug === to) || to === t) throw new FormError("Choose another team from the list.", "to");
      toTeam = to;
    }
  }
  if (!PLAYER_STATUSES.includes(toStatus)) throw new FormError("Unknown status.");
  if (pendingFor(t).some((r) => r.kind === "transfer" && r.player === slug)) throw new FormError("There is already a pending request for this player.", "player");
  return save(
    {
      id: randomUUID(),
      kind: "transfer",
      team: t,
      player: slug,
      toTeam,
      toStatus,
      note: optionalText(form, "note", { max: 200 }),
      status: "pending",
      createdAt: new Date().toISOString(),
      createdBy: actor(),
    },
    "request transfer",
  );
}

export function requestEvent(team: string | undefined, form: FormData) {
  const t = ownTeam(team);
  const slug = text(form, "event", { required: true, label: "Event" });
  const ev = snapshot().events.find((e) => e.slug === slug);
  if (!ev || ev.status === "completed") throw new FormError("Choose an upcoming or ongoing event.", "event");
  if (ev.teams.includes(t)) throw new FormError("Your team is already attending this event.", "event");
  if (pendingFor(t).some((r) => r.kind === "event" && r.event === slug)) throw new FormError("You already asked to join this event.", "event");
  return save(
    { id: randomUUID(), kind: "event", team: t, event: slug, note: optionalText(form, "note", { max: 200 }), status: "pending", createdAt: new Date().toISOString(), createdBy: actor() },
    "request event sign-up",
  );
}

export function cancelRequest(team: string | undefined, id: string) {
  const t = ownTeam(team);
  const r = snapshot().requests.find((x) => x.id === id);
  if (!r || r.team !== t) throw new FormError("That request isn't yours.");
  if (r.status !== "pending") throw new FormError("Only pending requests can be withdrawn.");
  return save({ ...r, status: "cancelled", decidedAt: new Date().toISOString(), decidedBy: actor() }, "withdraw request");
}

/* ------------------------------ Admin decisions -------------------------- */

export function decideRequest(id: string, approve: boolean, reason?: string) {
  const s = snapshot();
  const r = s.requests.find((x) => x.id === id);
  if (!r) throw new FormError("That request no longer exists.");
  if (r.status !== "pending") throw new FormError("This request was already decided.");
  if (approve) {
    if (r.kind === "transfer") {
      const p = s.players.find((x) => x.slug === r.player);
      if (!p) throw new FormError("The player no longer exists.");
      if (r.toTeam && !s.teams.some((t) => t.slug === r.toTeam)) throw new FormError("The destination team no longer exists.");
      setPlayerStatus(p.slug, r.toTeam ? "active" : (r.toStatus ?? "free"), r.toTeam || "");
    } else {
      const ev = s.events.find((e) => e.slug === r.event);
      if (!ev) throw new FormError("The event no longer exists.");
      if (!ev.teams.includes(r.team)) transaction((tx) => tx.put("event", ev.slug, { ...ev, teams: [...ev.teams, r.team] }), actor(), "add team to event");
    }
  }
  return save({ ...r, status: approve ? "approved" : "rejected", decidedAt: new Date().toISOString(), decidedBy: actor(), reason: reason || undefined }, approve ? "approve request" : "reject request");
}
