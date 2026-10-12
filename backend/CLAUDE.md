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

### `src/scrapers/weekly-update.js` — Weekly post-event refresh (`npm run weekly`)
- **Finds** completed ufcstats events dated after the latest `is_complete` DB event (and before today)
- **Per event, oldest first**: dry-runs `backfill-event.js`; applies only if clean (no abort/identity conflict, count matches, no VARIANT match, no suspect near-match on a fighter create, no interim title), with `--title` from ufcstats UFC title bouts; otherwise stops and reports
- **Then**: fills null `card_position` from agreeing neighbours, and (if anything was applied) runs rankings.js → computeCareerStats.js → computeRatings.js (scoped to the applied cards) → fix-fighter-records.js → validate.js
- **Output**: one line per step; full child output in a temp-dir log. Exits 1 on any stop/failure
- **Flags**: `--dry-run` · `--since YYYY-MM-DD`
- A namesake stop is resolved by running `backfill-event.js --ufc-id <event> --new-fighter <fighter ufc_id>` by hand, then re-running weekly

### `src/scrapers/backfill-event.js` — Single-event backfill from ufcstats
- **Flags**: `--ufc-id ID` · `--apply` · `--title "0,3"` · `--new-fighter ID[,ID]` (create a verified same-name namesake; slug gets `-2`, `-3`, ...) · `--summary-json PATH` · `--skip-results`
- ufcstats shows belt icons on TUF / Road to UFC tournament finals too; the dry run reads each belt bout's page title and only counts "UFC … Title Bout"

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
- Decided fights with a null `fighter1_id`/`fighter2_id` (check 6)

### Check 6 — decided fights with a null participant

An **upcoming** bout may legitimately hold a null fighter id (booked, but the fighter
row does not exist yet). A **decided** one may not: `result` is set but one side has no
id. Such a row cannot be scored by fighter, cannot be matched by id, and is invisible
to every pair-keyed map in the scrapers.

`join()` renders null as an empty string and object keys stringify it as `"null"`, so
two placeholder bouts on one card collapse onto a shared key. Every id-keyed map in the
scrapers and in checks 1 and 5 therefore **excludes** null-participant rows and check 6
reports them on their own terms. `validate.js` and `fix-fighter-records.js` use
identical null-safe arithmetic — a bout with one known participant counts for that
fighter and skips the missing side. If the two ever diverge, check 4 reports a mismatch
that `fix-fighter-records.js` can never resolve.

When `result = 'win'` and both `winner_id` and `fighter1_id` are null, who won is
unknowable from the row; both files credit nobody rather than guess.

`backfill-event.js` never auto-deletes a null-participant row (it is unmatchable by id,
so it always classifies as stale even when it is on the source card).

---

## Predictor (`src/ml/`)

**Shipped model: `model-v4.json`** (written by `trainModel.js`, read by `predictionEngine.js`).
The file carries the feature list, standardization, weights, the **config** it was trained
under and the **league priors**, so serving always matches training:

| Knob (`features.js DEFAULT_CONFIG` → `trainModel.js TRAIN_CONFIG`) | v4 value | What it does |
|---|---|---|
| `shrinkMinutes` | 30 | every rate stat = (sum + k·prior) / (minutes + k); prior = division mean (global fallback) over fights before 2019-01-01 (`statsEngine.computePriors`) |
| `halfLifeDays` | 1095 | stats-fight sums decay by 0.5^(days/halfLife) back from the as-of date |
| `layoffCapDays` | 730 | `layoff_days` capped |
| `winShrinkFights` | 2 | `win_rate` / `pro_win_rate` = (w + k·0.5)/(n + k) |
| `clipZ` | 3 | standardized features clipped at ±3 (`features.standardize`) |
| `eloK` / `eloFinishMult` | 100 / 1.5 | `eloEngine.computeElo`: point-in-time Elo replayed in date order; KO/SUB wins step K×1.5 |

All knobs default OFF, so `computeCareerStats.js` and the fighter pages keep raw career
numbers (verified: Holloway dry-run == DB row after the change). Training includes
debutants (`TRAIN_MIN_PRIOR = 0`); the pro record as of the fight is approximated as the
current `pro_wins/pro_losses` minus UFC results on or after the date (fights outside the
UFC after that date are not removed — small overcount for fighters who left and kept fighting).
`fighter1_record_at_fight` is empty on every row, so there is no better source yet.

**Opponent strength (Phase 2).** `eloEngine.js` replays every decided fight in date order;
`summaryAsOf(fighterId, date)` returns the rating before any fight on that date, strength
of schedule (`sos` = mean opponent Elo at the time of each fight), best beaten opponent and
3-fight momentum. `statsEngine.annotateOpponentPriors(timelines)` attaches to each
stats-fight the opponent's RAW rates as they stood before that fight (`e.oppPrior`), and
`snapshot()` then emits `slpm_adj` / `sapm_adj` (own rate minus what the opponents faced
typically allow/land; unknown opponents fall back to the league prior) and `td_avg_adj`.
Shipped features: `elo`, `opp_adj_slpm`, `opp_adj_sapm` (`sos` was gated out). The quality-score columns
on `fights` (`fighterN_quality_score`) are still null — Elo lives in the model path only.

**Serving** (`predictionEngine.js`): `sideFeatures(timeline, fighter, today, null, CFG, PRIORS, ELO)`
for the model, raw `snapshot()` for round projections. Confidence: `high`/`medium`/`low` by
probability margin, capped at `medium` when `weight_class_context.has_size_mismatch`, forced
`low` when a side has <2 stats-fights or <30 min of stat time. Rate-stat factor rows carry a
"thin sample" note under 30 min. Cache rows are keyed by `model_version` (`v4`); old `v3`
rows are simply never matched.

### Evaluation (`evaluate.js`, `npm run eval:predictor`)

Every feature or model decision goes through the rolling-origin harness, never through
`trainModel.js`'s report split. The harness imports the trainer's dataset builder, trainer
and scorer. It writes nothing to the DB and never touches the model file.

- **Folds**: one per year (`--from 2019 --to <now>`); train on all usable fights before
  Jan 1 of the year, test on that year. Standardization is fit per fold on train rows.
- **Reports**: per-fold and pooled accuracy / log loss / Brier; baselines fit the same
  way on `win_rate`, `age`, and both; pooled calibration; accuracy per confidence label;
  count of rows with a standardized feature beyond ±3.
- **Market baseline**: de-vigged closing consensus from the `odds` table (prefers
  `line_type='closing'`, else latest line per bookmaker; proportional de-vig averaged
  across books). `odds.fighter1_odds` refers to DB `fighter1_id`; the harness re-orients it
  through the row's hash flip. Reported as skipped while the table is empty.
- **Sanity set** (`sanitySet.json`): lopsided / cross-weight matchups served full-career as
  of today through both the shipped model (with its stored config) and the candidate.
  Pass = expected side gets ≥ `minProb`. Judgment list keyed by fighter slug; edit freely.
- **Feature gate** (`--ablate`): leave-one-feature-out across all folds. KEEP only if
  including the feature lowers mean fold log loss and raises it in at most one fold.
  `--baseline report.json` applies the same rule to this run vs a saved report. With 8
  folds, deltas under ~0.001 are noise. The ≤1-fold rule is strict and stays as written
  (user decision 2026-10-12): the Phase-1 config alone (−0.006 mean) failed it on fold
  count (worse in 2022 +0.006, 2023 +0.002, 2026 +0.022); Phases 1+2 together pass
  (−0.016 mean, worse only in 2026 +0.007). Always read the per-fold deltas too.
- **Flags**: `--features a,b,c` · `--min-prior N` · `--score-min-prior N` (score only test
  rows whose thinner side has ≥ N; use 2 to compare a `--min-prior 0` run with Phase 0)
  · `--shrink K` · `--half-life DAYS` · `--layoff-cap DAYS` · `--win-shrink N` · `--clip Z`
  · `--elo-k K` · `--elo-finish M` · `--ablate` · `--out PATH` · `--baseline PATH` · `--no-sanity`
- Knobs off + the 19 Phase-0 features reproduces `reports/baseline-phase0.json` exactly.

### Results log (`reports/`)

| Report | Setup | Pooled (min-prior-2 subset, 2,508 fights) | Sanity |
|---|---|---|---|
| `baseline-phase0.json` | 19 raw features, min-prior 2 | 62.6% / logloss 0.6482 | 8/27 |
| `phase1-candidate.json` | +pro_win_rate, pro_fights; v4 config; min-prior 0 | 64.2% / logloss 0.6417 | 11/27 |
| `phase1-2.json` | **shipped v4**: 18 features (see below); Elo K 100 ×1.5 finishes; min-prior 0 | 64.8% / logloss 0.6298 | 19/27 |

Phase-2 findings (2026-10-12): opponent-adjusted striking alone −0.0046 (passes the gate
on its own); Elo alone −0.0007 at K 40 but keeps improving with larger steps (K 60 −0.0019,
K 100 ≈ K 150) and a finish bonus (×1.5 −0.0099 with Elo+SoS+adjusted striking).
Leave-one-out under the final config: KEEP = `age` (+0.0094 if removed), `elo` (+0.0027),
`opp_adj_sapm`, `opp_adj_slpm`, `str_acc`, `layoff_days`, `pro_fights`; `sos` fell to
+0.0004 once K was 100; `slpm`, `kd_absorbed_per15`, `cardio_degradation`, `experience`,
`recent_win_rate`, `form_trend` were at or below zero. Dropping those seven gave the best
set that passes vs Phase 0 (−0.0175 mean, worse only in 2026); the 7-feature KEEP-only
set was worse (0.6368, 2 folds). Shipped 18: sapm, str_acc, str_def, td_avg, td_acc,
td_def, sub_avg, kd_per15, win_rate, age, reach, height, layoff_days, pro_win_rate,
pro_fights, opp_adj_slpm, opp_adj_sapm, elo. Deployed to Railway 2026-10-12 (cache cleared
first; production verified serving `model_version: v4` with Elo factors).

**Phase-3 findings (2026-10-12) — nothing shipped.** Built and gated, all available in
`features.js` but in `TRAIN_EXCLUDED`: career phase (`age_sq` −0.0010 but worse in 2 folds;
`years_active`, `ko_losses_career`, `ko_losses_24m` ≈0; `fights_12m` +0.0047), fight
context (`five_round_fights`, `five_round_fights_sched` = count × this-bout-is-5-rounds
interaction, `late_round_cardio` ≈0), size (`natural_limit`, `moving_up_lbs`,
`off_division_fights` all +0.0002). Bout context now flows through `sideFeatures(..., bout,
limitByWc)`: training reads `time_format` and the fight's weight class (imputed from both
fighters' modal division within ±2 years when null — 457 of 626 null rows, 169 unknown; the
DB rows are untouched, `fix-fight-weight-class.js` would need the ufcstats gate solver to
fix them properly); serving reads `opts.scheduledRounds` or the pair's shared history, and
the bout weight class the route derived.

**Why size cannot be learned from UFC data:** among 6,390 training rows with both natural
divisions known, 4,764 have no gap; with a 1–15 lb gap the naturally bigger fighter wins
49.5% (n=1,185), 16–30 lb 47.6% (n=292), 31–60 lb 39.4% (n=127). Cross-division bouts are
matchmade to be competitive, so "bigger wins" is absent from the evidence, and the
hypothetical cross-weight sanity pairs (Ngannou–Topuria, Miocic–Johnson,
Pereira–Dvalishvili) are out of distribution for any model trained on real cards. The
engine therefore flags any matchup with a natural-division gap ≥ 30 lb
(`CROSS_WEIGHT_LBS`): confidence forced to `low` and a leading key-factor line says the size
advantage is not in the numbers. Any stronger cross-weight adjustment would be a hand-set
prior, not evidence — a product decision, not a modelling one.

Phase-1 findings (2026-10-12): shrinkage alone −0.002, pro record alone −0.0027, layoff cap
−0.0006, win-rate shrink −0.0005, decay and clipping ≈0 alone but decay helps in
combination; `stats_minutes` as a feature failed the gate (+0.0006). Training on debutants
costs +0.0004 on the experienced subset and makes the model valid for the full serving
population (3,929 test fights, 62.6% / 0.6495). Ablation under v4 config: `age` (+0.0083
if removed), `str_acc`, `str_def`, `layoff_days`, `pro_fights` pass; `pro_win_rate`
(+0.0014), `td_avg` (+0.0026), `sapm` (+0.0020) help on mean but fail the fold count.
Cross-weight sanity pairs still fail — that is Phase 3 (size / weight-class features).
