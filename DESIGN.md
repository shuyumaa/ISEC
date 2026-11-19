# ISEC design system

Modern, simple and direct. It follows the structure of IBM's Carbon design system (2x grid, square corners, IBM Plex, productive type), restricted to black, white and neutral grays.

## Principles

1. **Achromatic.** No hue anywhere. Every colour is a neutral from the Carbon gray ramp.
2. **Hierarchy through weight, size and inversion.** Winners are bold and full-contrast, losers recede to muted gray. Emphasis such as LIVE, ongoing and win pills uses inverted (solid) blocks.
3. **Never colour alone.** State is always repeated as text or shape: the "LIVE" label, a 2px current-page bar, ↑/↓ icons with hidden text, W/L letters.
4. **Square and ruled.** Zero radius, 1px dividers, 2px rules under panel headings.

## Tokens (`src/styles/tokens.css`)

| Semantic token | Light | Dark |
| --- | --- | --- |
| `--background` | `#ffffff` | `#000000` |
| `--layer` (hover rows, table heads) | gray-10 `#f4f4f4` | gray-100 `#161616` |
| `--layer-hover` | gray-20 | gray-90 |
| `--border-subtle` | gray-20 | gray-80 |
| `--border-strong` | gray-60 | gray-60 |
| `--text-primary` | `#000000` | `#ffffff` |
| `--text-secondary` | gray-70 (7.8:1) | gray-30 (12.6:1) |
| `--text-muted` | gray-60 (5.0:1) | gray-50 (6.3:1) |
| `--inverse` / `--on-inverse` | black / white | white / black |

Tokens are built with `light-dark()` and fall back to a `prefers-color-scheme` branch in older browsers. Forced-colours mode maps them to system colours.

- **Type:** IBM Plex Sans 300/400/500/600, with IBM Plex Mono for scores, times and tags. Sizes use `rem`, and the large display sizes use `clamp()`.
- **Spacing:** Carbon scale `--sp-01` (2px) to `--sp-11` (80px).
- **Layout:** 90rem container. Page grids respond to container queries on `main`, not to viewport breakpoints.

## Theme

- The page follows the OS setting by default.
- The header toggle has two states. It switches to the opposite of what is currently shown, and it stores an override only when that differs from the system setting.
- The state lives in `<meta name="color-scheme">`, set by a tiny inline script before first paint, and is synced across tabs.

## Logo

- The ISEC wordmark is traced to a single vector path (`src/components/logo-path.ts`) and drawn with `fill="currentColor"`. One asset is therefore black on the light theme and white on the dark theme.
- The original artwork lives in `public/brand/`: `isec-logo-on-light.webp` and `isec-logo-on-dark.webp`, plus a standalone black `isec-logo.svg`.

## Components

| Component | Purpose |
| --- | --- |
| `Header` | Measured responsive navigation: inline when it fits, a native popover otherwise; theme toggle |
| `Scoreboard` | Large match header (live / final / countdown) |
| `MatchRow` | List row used for live, upcoming and results |
| `Panel` | Titled section with an optional "View all" link |
| `StatsTable` | Sortable, sticky-header, horizontally scrollable stats table |
| `TeamMark` | Monochrome monogram (replace with real team SVGs using `currentColor`) |
| `EventCard`, `RankingList`, `NewsList`, `Breadcrumbs`, `LocalTime`, `Countdown`, `Icon`, `Stars` | Supporting components |
