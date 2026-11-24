import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { AstroCookies } from "astro";
import { db, transaction } from "./db";
import { FormError } from "./forms";

/*
 * Accounts and sessions.
 *
 * Roles:
 *  - admin: the whole admin panel. The root admin comes from ADMIN_USER /
 *    ADMIN_PASSWORD (environment); admins can create more admin accounts.
 *  - team: the team panel for one team only (its profile, its players,
 *    requests for transfers and event sign-ups).
 *
 * Passwords are hashed with scrypt and a per-account salt. Sessions are
 * stateless HMAC-signed cookies (SESSION_SECRET), HttpOnly, SameSite=Lax,
 * Secure + __Host- prefix over HTTPS. Each session carries a fingerprint of
 * the account's password hash, so changing a password or disabling an
 * account signs that account out everywhere.
 */

export type Role = "admin" | "team";

export interface Account {
  id: string;
  username: string;
  role: Role;
  /** Team slug, for team accounts. */
  team?: string;
  salt: string;
  hash: string;
  createdAt: string;
  createdBy: string;
  disabled?: boolean;
}

/** What a page or the middleware knows about the signed-in user. */
export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  team?: string;
}

/* ------------------------------ Root admin ------------------------------- */

function resolvePassword(): string {
  if (process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 12) console.warn("[isec] ADMIN_PASSWORD is shorter than 12 characters.");
    return process.env.ADMIN_PASSWORD;
  }
  // The fallback exists only for `astro dev`; a built server never starts without a password.
  if (!import.meta.env.DEV) throw new Error("ADMIN_PASSWORD must be set.");
  const dev = "isec-admin";
  console.warn(`[isec] ADMIN_PASSWORD not set — using the development password "${dev}".`);
  return dev;
}

export const ROOT_USER = process.env.ADMIN_USER ?? "admin";
const rootSalt = randomBytes(16);
const rootPassword = resolvePassword();
const rootHash = scryptSync(rootPassword, rootSalt, 32);
// Deterministic fingerprint (not a stored hash): binds root sessions to the password.
const rootVer = createHash("sha256").update(`isec-root:${rootPassword}`).digest("hex").slice(0, 16);

const secret = process.env.SESSION_SECRET ?? randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET && !import.meta.env.DEV) {
  console.warn("[isec] SESSION_SECRET not set — sessions will reset on every restart.");
}

/* ------------------------------- Accounts -------------------------------- */

const USERNAME = /^[A-Za-z0-9._-]{3,32}$/;
export const MIN_PASSWORD = 10;

const hashPassword = (password: string, salt: string) => scryptSync(password, Buffer.from(salt, "hex"), 32).toString("hex");
const verOf = (a: Pick<Account, "hash">) => a.hash.slice(0, 16);

function rows(): Account[] {
  return (db.prepare("SELECT data FROM docs WHERE kind = 'account' ORDER BY rowid").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Account);
}

/** All accounts without their password material (for the admin list). */
export function listAccounts(): Omit<Account, "salt" | "hash">[] {
  return rows().map(({ salt: _s, hash: _h, ...rest }) => rest);
}

const findById = (id: string) => rows().find((a) => a.id === id);
const findByName = (username: string) => rows().find((a) => a.username.toLowerCase() === username.toLowerCase());

function checkNewPassword(password: string) {
  if (password.length < MIN_PASSWORD) throw new FormError(`Use at least ${MIN_PASSWORD} characters for the password.`, "new-password");
  if (password.length > 200) throw new FormError("That password is too long.", "new-password");
}

export function createAccount(input: { username: string; password: string; role: Role; team?: string }, actor: string): Account {
  const username = input.username.trim();
  if (!USERNAME.test(username)) throw new FormError("Usernames are 3–32 letters, numbers, dots, dashes or underscores.", "username");
  if (username.toLowerCase() === ROOT_USER.toLowerCase() || findByName(username)) throw new FormError("That username is taken.", "username");
  checkNewPassword(input.password);
  if (input.role === "team" && !input.team) throw new FormError("Choose the team this account manages.", "team");
  const salt = randomBytes(16).toString("hex");
  const account: Account = {
    id: randomUUID(),
    username,
    role: input.role,
    team: input.role === "team" ? input.team : undefined,
    salt,
    hash: hashPassword(input.password, salt),
    createdAt: new Date().toISOString(),
    createdBy: actor,
  };
  transaction((tx) => tx.put("account", account.id, account), actor, `create ${input.role} account ${username}`);
  return account;
}

export function setAccountPassword(id: string, password: string, actor: string) {
  const a = findById(id);
  if (!a) throw new FormError("That account no longer exists.");
  checkNewPassword(password);
  const salt = randomBytes(16).toString("hex");
  transaction((tx) => tx.put("account", a.id, { ...a, salt, hash: hashPassword(password, salt) }), actor, `reset password of ${a.username}`);
}

export function setAccountDisabled(id: string, disabled: boolean, actor: string) {
  const a = findById(id);
  if (!a) throw new FormError("That account no longer exists.");
  transaction((tx) => tx.put("account", a.id, { ...a, disabled }), actor, `${disabled ? "disable" : "enable"} account ${a.username}`);
}

export function deleteAccount(id: string, actor: string) {
  const a = findById(id);
  if (!a) return;
  transaction((tx) => tx.remove("account", a.id), actor, `delete account ${a.username}`);
}

/** Team accounts for a team (used when a team is deleted). */
export const accountsForTeam = (team: string) => rows().filter((a) => a.team === team);

/** Check a username and password. Returns the user, or null (same timing either way). */
export function verifyLogin(username: string, password: string): SessionUser | null {
  if (username === ROOT_USER) {
    const ok = timingSafeEqual(scryptSync(password, rootSalt, 32), rootHash);
    return ok ? { id: "root", username: ROOT_USER, role: "admin" } : null;
  }
  const a = findByName(username);
  // Hash anyway for unknown users so response time doesn't reveal which usernames exist.
  const salt = a?.salt ?? "00".repeat(16);
  const given = Buffer.from(hashPassword(password, salt), "hex");
  const stored = Buffer.from(a?.hash ?? "00".repeat(32), "hex");
  if (!a || a.disabled || !timingSafeEqual(given, stored)) return null;
  return { id: a.id, username: a.username, role: a.role, team: a.team };
}

/* -------------------------------- Sessions ------------------------------- */

const SESSION_HOURS = 12;
const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");
const SECURE_NAME = "__Host-isec_session";
const PLAIN_NAME = "isec_session";

/** `secure` = the visitor is on HTTPS (see servedOverHttps); then the __Host- prefix is used. */
export function createSession(cookies: AstroCookies, user: SessionUser, secure: boolean) {
  const ver = user.id === "root" ? rootVer : verOf(findById(user.id)!);
  const payload = Buffer.from(JSON.stringify({ sub: user.id, ver, exp: Date.now() + SESSION_HOURS * 3600_000 })).toString("base64url");
  cookies.set(secure ? SECURE_NAME : PLAIN_NAME, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export function destroySession(cookies: AstroCookies) {
  cookies.delete(SECURE_NAME, { path: "/", secure: true });
  cookies.delete(PLAIN_NAME, { path: "/" });
}

export function readSession(cookies: AstroCookies): SessionUser | null {
  const raw = cookies.get(SECURE_NAME)?.value ?? cookies.get(PLAIN_NAME)?.value;
  if (!raw) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { sub: string; ver: string; exp: number };
    if (!(data.exp > Date.now())) return null;
    if (data.sub === "root") return data.ver === rootVer ? { id: "root", username: ROOT_USER, role: "admin" } : null;
    const a = findById(data.sub);
    if (!a || a.disabled || verOf(a) !== data.ver) return null;
    return { id: a.id, username: a.username, role: a.role, team: a.team };
  } catch {
    return null;
  }
}

/*
 * Login throttling, built so a school or office behind one shared address
 * can't be locked out by someone else on it (or outside it):
 *  - per address + username: 5 free failures, then a growing wait
 *    (30 s, 1, 2, 4 … up to 15 min) for that pair only;
 *  - per username, from anywhere: 10 free failures, then the same growing
 *    wait, except from addresses that signed in to that account before
 *    (so guessing "admin" can't lock the real admin out);
 *  - per address, all usernames: a high cap (60 failures in 15 min) against
 *    password spraying, far above what a shared network makes by typos.
 * A refusal tells the client how long to wait (429 + Retry-After).
 */
type Counter = { n: number; last: number };
const WINDOW = 15 * 60_000;
const pairs = new Map<string, Counter>();
const users = new Map<string, Counter>();
const ips = new Map<string, Counter>();
const trusted = new Map<string, number>(); // `${ip}|${user}` → last successful sign-in

const norm = (u: string) => u.trim().toLowerCase();
const fresh = (c: Counter | undefined) => (c && Date.now() - c.last < WINDOW ? c : undefined);
const bump = (m: Map<string, Counter>, k: string) => {
  const c = fresh(m.get(k));
  m.set(k, { n: (c?.n ?? 0) + 1, last: Date.now() });
};
/** Seconds still to wait after `free` failures, doubling from 30 s up to the window. */
const waitFor = (c: Counter | undefined, free: number) => {
  if (!c || c.n < free) return 0;
  const step = Math.min(WINDOW, 30_000 * 2 ** (c.n - free));
  return Math.max(0, Math.ceil((c.last + step - Date.now()) / 1000));
};

/** 0 when a sign-in attempt may go ahead, otherwise the seconds to wait. */
export function loginWait(ip: string, username = ""): number {
  const u = norm(username);
  const known = trusted.has(`${ip}|${u}`);
  const ipC = fresh(ips.get(ip));
  return Math.max(
    waitFor(fresh(pairs.get(`${ip}|${u}`)), 5),
    known ? 0 : waitFor(fresh(users.get(u)), 10),
    ipC && ipC.n >= 60 ? Math.ceil((ipC.last + WINDOW - Date.now()) / 1000) : 0,
  );
}
export function recordFailure(ip: string, username = "") {
  // Prune old entries so the maps can't grow without bound.
  for (const m of [pairs, users, ips])
    if (m.size > 20_000) for (const [k, v] of m) if (!fresh(v)) m.delete(k);
  const u = norm(username);
  bump(pairs, `${ip}|${u}`);
  if (u) bump(users, u);
  bump(ips, ip);
}
export function clearFailures(ip: string, username = "") {
  const u = norm(username);
  pairs.delete(`${ip}|${u}`);
  users.delete(u);
  if (trusted.size > 20_000) trusted.clear();
  trusted.set(`${ip}|${u}`, Date.now());
}
