# ISEC design system

Modern, simple and direct. It is built on IBM's Carbon design system (2x grid, square corners, IBM Plex, productive type) and laid out like HLTV:
- a three-column shell with left and right rails;
- slate cards on a darker page;
- label and value rows, trophy strips and attribute bars;
- game-semantic colour.

## Principles

1. **Colour means something.** It never decorates. Each hue has one job (table below), and everything else is neutral.
2. **Never colour alone.** Every coloured state also has text or shape: the "LIVE" word, bold winners, ↑/↓ icons with hidden text, W/L letters, an icon per round ending, CT/T labels.
3. **High contrast.** The top bar is near-black in both themes. Every text pair is at least 4.5:1, and fills and icons are at least 3:1 (all computed).
4. **Square and ruled.** Zero radius, except Carbon tags, which are pills. 1px dividers, and 2px rules under panel headings.
5. **No eyebrow labels.** Headings carry their own weight; metadata goes in the line below.

## Colour roles (`src/styles/tokens.css`)

| Role | Light | Dark | Used for |
| --- | --- | --- | --- |
| Interaction | blue-70 `#0043ce` (buttons blue-60) | blue-30 `#a6c8ff` | links, primary buttons, focus, selected tab, sort state |
| Live | red-60 `#da1e28` (fill) | same | LIVE tag, live map outline, live scoreboard rule |
| Win / up | green-70 `#0e6027` | green-30 `#6fdc8c` | winning scores, rank rises, success |
| Loss / down | red-70 `#a2191f` | `#ffb3b8` | losing scores, rank drops, errors |
| CT side | `#4a6896` | `#7d9bd1` | round history, live log names |
| T side | `#9a6a1c` | `#de9b35` | round history, live log names |
| Tags | Carbon tag pairs (blue / green / purple / gray) | | event status (upcoming blue, ongoing green), Major tier purple |
| Neutrals | white → gray ramp → black | | surfaces, text, borders |

The top bar is light blue (blue-20, near-black text, dark-letter logo) in the light theme and deep navy (blue-90, white text, white embossed logo) in the dark theme. The text colour switches with it because white on light blue fails contrast. Pages use `--background`, and cards, panels and rails use `--surface`:

| Surface | Light | Dark |
| --- | --- | --- |
| Page background | `#e6ebf1` | `#161f2a` |
| Card surface | `#ffffff` | `#243040` |

All text pairs are checked on both surfaces. Tokens are built with `light-dark()` and fall back to a `prefers-color-scheme` branch in older browsers. Forced-colours mode maps them to system colours.

- **Type:** IBM Plex Sans 300/400/500/600, with IBM Plex Mono for scores, times and tags. Sizes use `rem`, and the large display sizes use `clamp()`.
- **Spacing:** Carbon scale `--sp-01` (2px) to `--sp-11` (80px).
- **Layout:** 90rem container. Page grids respond to container queries on `main`, not to viewport breakpoints.
- **Cascade layers:** `reset, tokens, base, layout, components, utilities`, declared inline at the top of `<head>` so the order never depends on stylesheet load order.

## Theme

- The page follows the OS setting by default.
- The header toggle has two states. It switches to the opposite of what is currently shown, and it stores an override only when that differs from the system setting.
- The state lives in `<meta name="color-scheme">`, set by a tiny inline script before first paint, and is synced across tabs.

## Logo

- The logo is the original ISEC artwork with its chromatic aberration and motion blur.
- The top bar always uses `isec-logo-dark` (white embossed letters), shown large (2.5–3.25rem tall) so the fringes are visible.
- The footer shows the theme's variant at 4–8rem.
- It's drawn by `.brand-logo` in `src/styles/protect.css` and served through the protected `/media/` route. See the README for how the protection works.

## Components

| Component | Purpose |
| --- | --- |
| `Header` | Measured responsive navigation: inline when it fits, a native popover otherwise; live-sync indicator; theme toggle |
| `LiveRegion` | Marks a server-rendered section that refreshes itself when its data changes |
| `RoundHistory` | HLTV-style round strip: one row per team, CT/T fill and an icon per round ending |
| `KillFeed` | Live log of the latest kills from the server feed |
| `Scoreboard` | Large match header (live / final / countdown) |
| `MatchRow` | List row used for live, upcoming and results |
| `Panel` | Titled section with an optional "View all" link |
| `StatsTable` | Sortable, sticky-header, horizontally scrollable stats table |
| `TeamMark` | Uploaded team logo, or a monochrome monogram |
| `Photo` | Protected player portrait (CSS background), or a silhouette |
| `Trophy`, `TrophyStrip` | Physical-looking cups (gold, silver, bronze on a black plinth) and MVP/EVP medals, or an uploaded trophy photo; HLTV-style tile strip |
| `LeftRail`, `RightRail` | Spotlight match, player of the week, ranking top 5, events; recent activity |
| `EventCard`, `RankingList`, `NewsList`, `Breadcrumbs`, `LocalTime`, `Countdown`, `Icon`, `Stars` | Supporting components |
