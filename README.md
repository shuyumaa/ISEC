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

Requires Node 22.13 or newer. Serve it behind HTTPS (Caddy, nginx, or your host's proxy) and list the public URL in `ISEC_HOSTS`.

## Admin panel (`/admin`)

| Section | What you can do |
| --- | --- |
| Dashboard | Score live matches, start upcoming ones ("Go live"), see connected viewers and recent activity |
| Matches | Schedule matches; edit details, maps, half-time sides, veto and per-map player stats; delete |
| Events | Create and edit events: dates, time zone, prize pool, attending teams, format, prize distribution, winner |
| Teams & players | Add and edit teams; add, edit and remove players |
| Ranking | Edit points and publish. Order and ↑/↓ movement are worked out for you |
| News | Write, edit and delete articles |

Live scoring works like this:
- Press **+1** for the team that won the round.
- At 13 rounds (or an overtime win) the map closes on its own, the next map opens, and the series finishes when a team has won enough maps.
- Half-time splits are recorded automatically.

Every change is saved, written to the activity log and pushed to visitors immediately.

All admin forms work as normal form posts without JavaScript. With JavaScript on, the score buttons save in place without reloading the page.

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

- **Admin password:** checked with scrypt.
- **Sessions:** signed cookies that are `HttpOnly` and `SameSite=Lax`, and `Secure` with the `__Host-` prefix over HTTPS. They last 12 hours.
- **Sign-in throttle:** 5 failed attempts per IP per 10 minutes.
- **Cross-site protection:** Astro's origin check rejects cross-site form posts. The Host header is only trusted for `ISEC_HOSTS`.
- **Headers:** `frame-ancestors 'none'` / `X-Frame-Options: DENY`, `nosniff`, HSTS over HTTPS, a Referrer-Policy and a Permissions-Policy.
- **Admin pages:** `no-store` and `noindex`.
- **Input checks:** every form value is re-checked on the server, whatever the browser already enforced.

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
