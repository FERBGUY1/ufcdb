# UFCDB Backend — Claude Context

## Project Overview

Node.js/Express REST API backed by Supabase (PostgreSQL). Stores UFC fighters,
events, and fights. React frontend at `../frontend`. The DB was originally seeded
from ufcstats.com (blocked by Cloudflare since June 2025); new data comes from
API-Sports, Wikipedia, and Tapology.

**Paths**
- Backend root: `C:\Users\ravis\OneDrive\Desktopﳛ2\backend`
- Frontend root: `C:\Users\ravis\OneDrive\Desktopﳛ2\frontend`
- `.env`: `backend/.env` (NOT the project root — `require('dotenv').config()` from any backend script resolves correctly)
- Entry point: `src/index.js`
- DB client: `src/db/client.js` (exports the Supabase JS client)

**Running scripts**
```
node -r dotenv/config src/scrapers/<script>.js [flags]
```
The `-r dotenv/config` preload is equivalent to adding `require('dotenv').config()` at the top.
On Windows, paths with spaces must be quoted or run via Git Bash.

---

## Data Conventions

### fights table

| Field | Convention |
|---|---|
| `fighter1_id` | **Always the winner** when `result = 'win'`. On draws/NC/upcoming, fighter1 is the red-corner/home fighter. |
| `fighter2_id` | Always the loser (or blue-corner for non-win results). |
| `winner_id` | `= fighter1_id` when result is 'win'; `NULL` for draw, no_contest, upcoming. |
| `result` | `'win'` · `'draw'` · `'no_contest'` · `'upcoming'` · `NULL` (legacy) |
| `method` | `'KO/TKO'` · `'SUB'` · `'U-DEC'` · `'S-DEC'` · `'M-DEC'` · `'DEC'` · `'NC'` · `'DQ'` · `'CNC'` · `'Draw'` · `'Overturned'` |
| `card_position` | `'main_card'` · `'prelim'` · `'early_prelim'` · `NULL` (historical events not yet processed by fix-bout-order.js) |
| `bout_order` | **0 = main event**, ascending integers. Higher number = earlier in the night. Ascending sort gives correct display order (main event at top). |
| `round` / `time` | Round number (int), time as `'M:SS'` string (e.g. `'4:26'`). |

### Display sort (EventPage)

Section order: `main_card` → `prelim` → `early_prelim`.
Within each section: **ascending `bout_order`** → `bo=0` (main event) at top, highest bo at bottom.
This produces "main event at top, opening bout at bottom" across the full page.

### events table

| Field | Notes |
|---|---|
| `is_complete` | `true` once all fights have results. |
| `slug` | Kebab-case event name used in UFC.com URLs. |
| `date` | ISO date string `'YYYY-MM-DD'`. |

### fighters table

Denormalized record stats: `wins`, `losses`, `draws`, `no_contests` (UFC record only).
`career_wins` / `career_losses` include non-UFC bouts (sourced from Sherdog/Tapology).
Run `fix-fighter-records.js` after any bulk fight insert/delete to resync UFC record fields.

---

## Scrapers

### `src/scrapers/events.js` — Primary event/fight importer
- **Source**: API-Sports (`v1.mma.api-sports.io`)
- **Scope**: 2022+ UFC seasons (replaces ufcstats.com which is Cloudflare-blocked)
- **Provides**: winner, weight class, event name/date, fight status
- **Does NOT provide**: method, round, time (those stay null and are filled by fix-fight-methods.js)
- **Flag**: `--season YEAR` · `--dry-run`

### `src/scrapers/fix-bout-order.js` — Bout order + card position
- **Source**: Wikipedia (all events) → API-Sports fallback (2022+ not yet on Wikipedia)
- **Sets**: `bout_order` (0=main event) and `card_position` for every fight
- **Convention**: Wikipedia tables list fights in card order; the script maps them to the DB
- **Flags**: `--dry-run` · `--wiki-only` · `--api-only` · `--event <name>` · `--force`

### `src/scrapers/fix-title-fights.js` — Title fight flags
- **Source**: Wikipedia (pre-2022 via `(c)` champion markers and "championship" text) + API-Sports headliner matching (2022+)
- **Sets**: `is_title_fight`, `is_interim_title`
- **Flags**: `--dry-run` · `--wiki-only` · `--api-only`

### `src/scrapers/fix-fight-methods.js` — Method/round/time backfill (Wikipedia)
- **Source**: Wikipedia UFC event pages
- **Scope**: Null-method fights on 2022+ events by default; `--all` flag covers pre-2022
- **Sets**: `method`, `method_detail`, `round`, `time`
- **Flags**: `--dry-run` · `--all` · `--event "<Name>"`

### `src/scrapers/tapology-scraper.js` — Pre-2022 fight history gaps
- **Source**: Tapology (headless Playwright/Chrome — requires `playwright-core` and a Chromium binary)
- **Scope**: Fighters with UFC records but missing pre-2022 fights in DB
- **Sets**: new `fights` rows with method/round/time, also updates social handles
- **Modes**: `--mode pre2022` (default) · `--mode all` · `--mode gaps`
- **Progress file**: `../tapology-progress.json` — delete or `--reset-progress` to restart
- **Flags**: `--dry-run` · `--limit N` · `--offset N` · `--reset-progress`

### `src/scrapers/sherdog-pro-records.js` — Full pro MMA record
- **Source**: Sherdog profile header (`div.winloses` win/lose/draws/nc counts)
- **Sets**: `pro_wins`, `pro_losses`, `pro_draws`, `pro_nc`; saves `sherdog_id` on first match
- **Matching**: strict full-name match; fightfinder results are alphabetical and paginated, so common surnames are located by binary-searching pages
- **Resume**: targets fighters where `pro_wins IS NULL`; safe to re-run
- **Guard**: skips fighters whose Sherdog record is smaller than their UFC record (wrong-profile signal)
- **Flags**: `--dry-run` · `--limit N`
- **Requires**: `src/db/migrations/2026-06-10-add-pro-record.sql` run in Supabase SQL editor

### `src/scrapers/fix-fighter-records.js` — Resync UFC record stats
- **Source**: fights table (recalculates from scratch)
- **Sets**: `wins`, `losses`, `draws`, `no_contests` on every fighter
- Run after any bulk fight insert, delete, or result correction.

### `src/scrapers/fix-fighter-status.js` — Active/retired classification
- **Source**: fights table (last fight date per fighter)
- **Rule**: Active if last fight ≥ 18 months ago OR has an upcoming fight; otherwise Retired
- **Sets**: `status` field (`'active'` | `'retired'`)

---

## Data Sources

| Source | Used For | Notes |
|---|---|---|
| **ufcstats.com** | Historical pre-2022 fights/fighters | Blocked by Cloudflare since June 2025; existing data is in DB |
| **API-Sports** | 2022+ events and fights | `~$15/mo`; key in `API_SPORTS_KEY` env var; returns winner but not method |
| **Wikipedia** | Bout order, fight methods, title fight flags | No bot protection; most reliable for pre-2024 results |
| **Tapology** | Pre-2022 fight history gaps, social handles | Requires Playwright (headless Chrome); rate-limit sensitive |
| **Sherdog** | Amateur records, career history | Used by `sherdog.js` / `sherdog-amateur.js` |
| **UFC.com** | Social handles, fighter photos | `social-handles.js` scraper |

---

## Known Gotchas

### Supabase query limits
- **1000-row cap**: Supabase returns at most 1000 rows per query. Always paginate with `.range(page * 1000, (page+1) * 1000 - 1)` in a `while(true)` loop when fetching full tables.
- **`.in()` URL length**: Batches of `.in('id', ids)` must be ≤ 100 IDs. 500-ID batches fail silently (URL too long).

### Name matching / normalization
All name-matching uses a `norm()` helper: lowercase, strip diacritics (NFD decompose + strip combining chars), replace Polish `ł/Ł` → `l`, strip non-alphanumeric. Always normalize both sides before comparing. Handles: Michał → michal, Łukasz → lukasz, etc.

### Duplicate / phantom fighters
Several fighters were imported twice (different scrapers used different name variants). Canonical IDs were kept; duplicates were merged or deleted in June 2026. Key known case:
- **Bruno Silva FW** (`06c62d6a`, "Bulldog", 125 lbs) vs **Bruno Silva MW** (`4deda0a0`, "Blindado", 185 lbs) — genuinely different people, not duplicates.

### Phantom fights (May 28, 2026 scraper)
A scraper run on 2026-05-28 created ~200 fight rows with wrong event assignments and null methods. Most were cleaned up in June 2026 by checking for same-fighter-pair fights at multiple events. When checking for phantom fights, filter for `created_at` between `2026-05-28T00:00:00` and `2026-05-29T00:00:00`.

### Early UFC tournament events (1993–1999)
Fighters legitimately appear in 2–3 fights per event (semi-finals + finals). Do NOT treat these as duplicate-fight errors. Affected events: UFC 1–17, Ultimate Ultimate 95/96, and similar.

### reimport-missing-fights.js — fight-existence matching (June 2026)
The re-import resolves **fighters** with the alias map + token + containment, but its **fight-existence check** must use the same logic or it duplicates fights that already exist under a different name. Original bug: `dbByPair`/`dbByTokenPair` compared raw Wikipedia names to DB names, so bouts where a fighter is stored under an alias target (Cyborg→Justino), a doubled mononym (`Aoriqileng Aoriqileng` vs wiki `Aoriqileng`), or a spelling/nickname variant (Phil/Philip Rowe, Mike Mathetha/Blood Diamond) were treated as "missing" and re-inserted — creating ~17 duplicate fights and ~10 duplicate fighters in the first apply. Fixed by: (1) a `resolveFighter`-based ID match (candidate-aware, so ambiguous alias targets like the two Bruno Silvas still match the right existing fight), and (2) a `seenPairs` guard that skips duplicate **Wikipedia listings** of the same bout (e.g. the Sakuraba/Silveira NC-then-overturned fight at Ultimate Japan 1997 is listed twice). A post-fix `--dry-run` should report ~0 new fights/fighters. If re-running this scraper, always follow with `fix-fighter-records.js` then `validate.js` and check sections 1 (duplicate fights) and 5 (double-booked) — the apply log counts are plan-time, so true inserts = `newFights.length − insert errors`.

### bout_order collisions
Two fights at the same event can share a `bout_order` value if one has been assigned to the wrong `card_position` (e.g., a prelim fight incorrectly marked as main_card). The display sort groups by `card_position` first, so collisions across sections don't break rendering — but they should still be fixed.

### Windows path encoding
Running Node scripts from PowerShell on Windows paths with spaces requires quoting: `node "path with spaces/script.js"`. Git Bash handles this more gracefully. The project root is on OneDrive which adds spaces to the path.

### `.env` location
The `.env` file lives at `backend/.env`. Scripts using `require('dotenv').config()` resolve it relative to `process.cwd()` which must be the backend directory, or use the `-r dotenv/config` preload with `node` run from the backend root.

---

## Validation

Run `node src/validate.js` to check for:
- Duplicate fights (same fighter pair at same event)
- Fights with null `winner_id` where `result = 'win'`
- `bout_order` conflicts (same order value within same event + card_position)
- Fighter record mismatches (stored wins/losses vs recalculated from fights)
- Fighters appearing twice at same modern (post-1999) event
