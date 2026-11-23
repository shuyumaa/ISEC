# ISEC

The website for ISEC CS2 competitions. It covers live matches, results, events, the world ranking, player stats and news, with an admin panel for running everything. Score changes reach every open page within about a second, without a reload.

Built with [Astro](https://astro.build) in server mode on Node. Data lives in SQLite through Node's built-in `node:sqlite`, so there is no database server and no native dependency.

## Quick start

```bash
npm install
npm run dev                      # http://localhost:4321  (admin: /admin, user "admin", password "isec-admin")
```

The first run creates `./data/isec.db` and fills it with demo data. Set `ISEC_SEED=false` to start empty instead.

Production:

```bash
cp .env.example .env             # set ADMIN_PASSWORD, SESSION_SECRET, ISEC_HOSTS
npm run build
npm start
```

or with Docker (mount a volume for the database):

```bash
docker build -t isec .
docker run -p 4321:4321 -v isec-data:/data --env-file .env isec
```

Requires Node 22.23.4 or newer (Astro 7). Serve it behind HTTPS (Caddy, nginx, or your host's proxy) and list the public URL in `ISEC_HOSTS`. The sign-in and form origin check reads `ISEC_HOSTS` when the server starts, so setting it at run time is enough; passing it at build time as well (the Dockerfile accepts it as a build argument) also lets Astro rewrite its own request URLs.

## Pages

The layout follows HLTV: a top bar with search, a left rail (next match, "Award by ISEC" player of the week, "Ranking by ISEC", events with logos and "in N days") and a right rail (recent activity, recent transfers), around slate content cards. Every rail box can be switched off or renamed in Site settings. Teams and players carry country flags; match headers show each team's flag faded towards the middle.

| Route | What it shows |
| --- | --- |
| `/` | Featured live match, or the latest news when nothing is live; then live now, upcoming and news |
| `/players/` | Player rank: Overall, Rating, MVPs and EVPs, filterable by season, event, team, role and minimum maps |
| `/players/<slug>/` | Profile: portrait, age, team, role, prize money, trophy count, trophy strip, statistics bars, upcoming and recent matches, achievements, trophy case |
| `/players/<slug>/stats/` | Stats: rating gauge, KPR/DPR/KAST/ADR/opening/HS% with GOOD/OKAY/POOR verdicts, attribute cards; season/event/role filters |
| `/teams/<slug>/` | Lineup band, rank, points, average age, coach, form, trophy strip, roster, matches, achievements, map pool, stats |
| `/best-of-season/` | Latest published season: #1 player, top 10, team of the season, archive |
| `/search/?q=` | Players and teams; an exact single match opens it directly |
| `/ranking/` | School Teams Rank (the name is editable in settings), with a "How points work" box |
| `/events/<slug>/` | HLTV-style event page: section menu, overview facts, related events, Swiss "Group play" diagram, playoff bracket, matches, prize distribution, teams attending, formats, map pool, top players |
| `/transfers/` | Every roster move by month, filterable by team |

## Player stats and attributes

Stats come per map, either from the server feed, entered in the admin, or pasted as a Perfect World (完美世界) / CSV export. Rating, ADR, KAST, HS%, RWS and K/D are shown as reported. The HLTV-style attributes are each a 0–100 percentile against ranked players (or the same role), next to the raw value:

| Attribute | Based on |
| --- | --- |
| Firepower | ADR |
| Entrying | K/D |
| Opening | RWS |
| Trading | KAST |
| Clutching | Clutch win % from raw clutch wins ÷ attempts. Small samples are pulled toward the field average (5-attempt prior), so one lucky 1v1 isn't a 100% clutcher |
| Utility | (utility damage + 25 × flash assists) ÷ rounds |

The overall player rank is out of 100: 55% rating percentile, plus 15 per MVP, 6 per EVP, 8 per event win and 4 per runner-up, capped at 100.

## Ranking maths (automatic)

The team ranking and player Elo are worked out from results (`src/data/elo.ts`); nobody types points in. They recalculate whenever a result changes, and open pages update live.

**Teams** (one update per completed series, zero-sum):

- Expected result: `E = 1 / (1 + 10^((opponent − team) / 400))`
- Weight: `K = k × tier × format × margin`, where margin = `1 + marginStep × (map difference − 1)`
- Change: `Δ = round(K × (result − E))`, result 1 for a win and 0 for a loss. The loser loses what the winner gains.
- Ranking points = Elo + the admin's adjustment (for forfeits, penalties). Movement compares positions with 7 days ago.

**Players** (one update per map with stats):

- Team part: `playerK × tier × (map result − E)`, with E from the two lineups' average Elo
- Form part: `perf × (HLTV rating − 1.00)`, capped at ±perf/2

Defaults: start 1000, k 40, playerK 24, perf 30, marginStep 0.25; tiers Major 1.5, Premier 1.25, Open 1, Academy 0.75; Bo1 0.8, Bo3 1, Bo5 1.2. All of them can be edited in **Admin → Ranking → Ranking maths**.

## Admin panel (`/admin`)

| Section | What you can do |
| --- | --- |
| Dashboard | Score live matches, start upcoming ones ("Go live"), see connected viewers and recent activity |
| Matches | Schedule matches; edit details, maps, half-time sides, veto and per-map player stats; delete |
| Events | Dates, time zone, prize pool, attending teams, format lines, Swiss rules, map pool, related events, prize rows with a team picker, winner, MVP/EVPs, logo and trophy photo |
| Teams | Team details (country picker), roster table with Bench / Activate / Release, sign a free agent or a player from another team, ranking-points chart, roster moves |
| Players | Search and filter by status and team; one-click Bench / Activate / Release / Retire; full player editor (profile, team and status, game-server IDs, photo, move history) |
| Ranking | Computed from results (see Ranking maths); per-team adjustments and editable constants |
| News | Write, edit and delete articles |
| Seasons & awards | Create seasons, set the top 10 (or fill it from the season's ratings) and the team of the season, publish |
| Site settings | Ranking and season page names, announcement bar, pinned home match, home list sizes, minimum maps for the player rank, footer text |

More customisation:
- **Events:** MVP and EVP awards, a photo of the real trophy, and prize rosters captured automatically.
- **Teams:** logo upload.
- **Players:** photo upload, join date, in-game name and Steam ID.
- **Match stats:** the extra Perfect World fields (RWS, first kills and deaths, clutches, utility damage, flash assists), plus a CSV paste box.

Uploads are checked by their actual file bytes (PNG, JPEG or WebP, up to 5 MB), stored under `DATA_DIR/uploads`, and served through `/media/u/` with the same protection as the logo.

Live scoring works like this:
- Press **+1** for the team that won the round.
- At 13 rounds (or an overtime win) the map closes on its own, the next map opens, and the series finishes when a team has won enough maps.
- Half-time splits are recorded automatically.

Every change is saved, written to the activity log and pushed to visitors immediately.

All admin forms work as normal form posts without JavaScript. With JavaScript on, the score buttons save in place without reloading the page.

## Accounts and the team panel

Everyone signs in at **`/login`**. Admins land in `/admin/`, team accounts in `/team/`.

- **Root admin:** `ADMIN_USER` / `ADMIN_PASSWORD` on the server.
- **More accounts:** Admin → **Accounts** creates admin accounts (full access) and team accounts (one team each). Passwords are at least 10 characters and hashed with scrypt. Resetting a password or disabling an account signs that account out everywhere. Deleting a team disables its team accounts.
- **Team panel** (`/team/`): the team's ranking, roster and next matches; edit the team profile and logo; add players and edit them (photo, country, role, Steam ID); bench or activate players.
- **Requests:** releasing, retiring or moving a player to another team, signing a player, and joining an event are sent as requests. Admins approve or reject them under **Team requests**; approving applies the change and records the transfer.
- **Isolation:** every team action is checked on the server, so a team account can't open or change another team's players, the admin pages, or the event list directly. The activity log names the account behind each change.

## Transfers

Changing a player's team or status (active, benched, free agent, retired) records a move with its date and an optional note. Moves feed the home page's transfer box, `/transfers/`, team pages and player profiles. Results stay on the right team after a move: lineups and Elo use the team a player was on *on the match day*. Deleting a team turns its players into free agents instead of deleting them, and a player with stats can only be retired, not deleted.

## Swiss and playoff brackets

Give an event a Swiss stage prefix (e.g. `Swiss`) and its wins/losses limits. Matches whose stage starts with that prefix (`Swiss: Round 1`) are placed by the record their teams had going in, and unplayed slots show as `?` with the final shape worked out from the field size. Matches named Quarter-final, Semi-final and Final build the playoff bracket.

## Auto-sync from the game server

Like HLTV's scorebot, ISEC can read a match straight from the tournament server, with no one typing scores:

1. In the admin, open the match and choose **Connect a server** under "Game server feed".
2. Paste the generated commands into the CS2 server console (or the match config):
   ```
   mp_teamname_1 "Team A"
   mp_teamname_2 "Team B"
   mp_logdetail 3
   log on
   logaddress_add_http "https://<your-site>/api/ingest/cs2/<key>"
   ```
3. The server now streams its event log to ISEC. Scores, round history (who won each round and how), the live kill log, and player kills, deaths, assists, ADR, KAST and headshot % update on every open page as they happen. Maps close and the series finishes by the same rules as manual scoring.

How the feed matches things up:
- **Sides:** worked out from the server's team names, or from known players' sides when names aren't set. Set each player's in-game name or Steam ID under Teams & players so the feed recognises them. Unrecognised names are listed on the match's admin page.
- **No server access:** use the Game State Integration file shown on the same page from an observer or caster PC instead.
- **Security:** the key in the URL is the credential, because CS2 can't send headers. **Generate a new key** invalidates the old one, and **Disconnect** stops the feed. Requests with an unknown key get `404`.

## How live sync works

1. Every admin write runs in a SQLite transaction and is broadcast on an in-process change bus (`src/server/bus.ts`).
2. `/api/live` streams those changes as **Server-Sent Events**. Browsers reconnect automatically and catch up on anything they missed.
3. Each page marks the parts that can change with `<LiveRegion deps="match:2380111 …">`. When a matching change arrives, the page fetches its fresh HTML and swaps only those parts in place. Scroll position, focus, open tabs and anything you're typing are kept.
4. Score changes on a match page are announced to screen readers.
5. Without JavaScript, live pages reload themselves every 15–60 seconds.

The bus is per process. To run several instances behind a load balancer, swap `bus.ts` for Redis pub/sub or Postgres `LISTEN/NOTIFY`. The rest stays the same.

## Logo and content protection

- **Original artwork.** The logo is your PNG artwork (chromatic aberration and motion blur intact), with a light and a dark version. It lives in `private/brand/`, outside the public folder.
- **No image to save.** It's drawn as a CSS background, so there's no `<img>` to right-click, drag or "copy image". The variant follows the theme.
- **Locked-down file.** `/media/[file]` only returns the file when one of our own pages loads it as an image. Opening the URL directly, hot-linking from another site, or fetching it from a script gets `403`.
- **CSS protection (works with JavaScript off).** Selecting text, dragging images and the iOS long-press menu are disabled on the public site. The logo is hidden when printing.
- **JavaScript protection (added on top).** Copy, cut, right-click, drag and the save / print / select-all / copy / view-source shortcuts are blocked.
- **Exceptions.** Form fields and the admin panel behave normally.

To replace the logo, drop new files with the same names into `private/brand/`. You need `isec-logo-{light,dark}.png`, plus the `-480` and `-960` sizes in `.png` and `.webp`.

These measures stop casual copying. No website can stop screenshots, screen recording or a determined person with developer tools. Disabling text selection also makes things harder for people who rely on selecting text, for example to translate or have it read aloud.

## Security

- **Admin password:** checked with scrypt. A built server refuses to start without `ADMIN_PASSWORD`; the `isec-admin` fallback exists only under `npm run dev`.
- **Sessions:** signed cookies that are `HttpOnly` and `SameSite=Lax`, and `Secure` with the `__Host-` prefix over HTTPS. They last 12 hours. The signature is bound to the password, so changing `ADMIN_PASSWORD` signs everyone out.
- **Sign-in throttle:** 5 failed attempts per IP per 10 minutes.
- **Cross-site protection:** every non-GET request must carry our own `Origin` (the game-server ingest is exempt and authenticates with its key). The Host header is only trusted for `ISEC_HOSTS`.
- **Content Security Policy:** scripts only from this origin plus the hash of the one inline theme script; no inlined bundles; `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`. **Trusted Types** are enforced: the only HTML sink (the live-update parser) goes through one named policy, and no other policy may be created.
- **Other headers:** `X-Frame-Options: DENY`, `nosniff`, COOP `same-origin-allow-popups`, CORP `same-origin`, HSTS over HTTPS, a Referrer-Policy and a Permissions-Policy. No `Server`/`X-Powered-By` banner.
- **Request limits:** request bodies need a `Content-Length` and are capped before parsing (64 KB public, 26 MB admin uploads, 1 MB per ingest post). Ingest is rate limited per key. Live connections are capped per IP and in total.
- **Uploads:** type sniffed from the file bytes, random names, max 5 MB, served only as same-origin images. EXIF, XMP, IPTC and PNG text chunks (GPS, camera serials, author names) are stripped before saving.
- **No secret leaks:** feed keys never appear in the public live stream or the audit log. Data files are created owner-only (`0700` / `0600`). Error pages show no stack traces.
- **Admin pages:** `no-store` and `noindex`.
- **Input checks:** every form value is re-checked on the server, whatever the browser already enforced.
- **Dependencies:** pinned versions; `npm audit` reports 0 vulnerabilities.

## Project layout

```
src/
  data/           types + read API used by pages (reads the DB snapshot)
  server/         db.ts (SQLite), bus.ts (change bus), auth.ts, mutations.ts, forms.ts, seed/ (demo data)
  pages/          public site, /admin/*, /api/live (SSE), /media/[file] (protected logo)
  components/     UI components (+ admin/)
  scripts/        client scripts: live sync, theme, tabs, sorting, local times, protection, admin
  styles/         tokens, base, components, protect, admin
private/brand/    logo artwork (not publicly listed)
```

Design system: see [DESIGN.md](./DESIGN.md).
