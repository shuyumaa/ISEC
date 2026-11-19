# ISEC

The website for ISEC CS2 competitions: live matches, results, events, the world ranking, player stats and news, in a strictly black-and-white design system.

Built with [Astro](https://astro.build) as a static multi-page site. Pages ship almost no JavaScript, and every interactive feature is a progressive enhancement on top of semantic HTML.

## Getting started

```bash
npm install
npm run dev       # http://localhost:4321
npm run build     # type-check + static build to dist/
npm run preview
```

## Pages

| Route | What it shows |
| --- | --- |
| `/` | Featured match, live now, upcoming by day, latest news, top-10 ranking, events, recent results |
| `/matches/` | Live and upcoming matches grouped by day |
| `/matches/[id]/` | Scoreboard, per-map scores and halves, map veto, sortable player stats per map (tabs), head-to-head, more from the event |
| `/results/` | Completed series grouped by day |
| `/events/`, `/events/[slug]/` | Event list; event facts, format, prize distribution, matches, top players, teams |
| `/ranking/` | World ranking with points and movement |
| `/teams/`, `/teams/[slug]/` | Team list; roster, record, form, player stats, results, schedule |
| `/players/[slug]/` | Player rating, K–D, ADR, KAST, HS%, recent matches |
| `/stats/` | Sortable player leaderboard |
| `/news/`, `/news/[slug]/` | Articles with related teams and event |

## Data

All content comes from `src/data/`. The types in `src/data/types.ts` are the contract.

- `teams.ts`, `events.ts`, `news.ts`: fictional placeholder teams, players, events and articles.
- `matches.ts`: fixtures (who, when, series score). Maps, veto, round scores and player stats come from a seeded generator, so every build is identical.
- `index.ts`: query helpers (live/upcoming/results, head-to-head, leaderboards) and time helpers.

To go live, replace the mock modules with calls to your API or database that return the same shapes. Match times are stored as wall-clock times bound to the event's IANA time zone (Temporal `ZonedDateTime`, so DST is handled correctly) and are converted to each viewer's local time in the browser.

## Design system

See [DESIGN.md](./DESIGN.md).

## Browser support

The baseline is "Baseline Widely available". Newer features are feature-detected, and their polyfills load only when needed: Popover API, `focusgroup`, Temporal. Also used: `light-dark()` (with a media-query fallback), invoker commands (with a click fallback), and `moveBefore()` / element-scoped view transitions (plain reordering otherwise).
