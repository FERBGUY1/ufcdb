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
- **Then**: fills null `card_position` from agreeing neighbours, and (if anything was applied) runs rankings.js → computeCareerStats.js → computeRatings.js (scoped to the applied cards) → fix-fighter-records.js → wiki-short-notice.js → sherdog-pro-records.js (+ `--ids` for card fighters with no `sherdog_id`) → sherdog-history.js → computeGlickoRatings.js (refreshes the `glicko_ratings` table the predictor serves from) → grade-predictions.js → validate.js. grade-predictions.js also runs when no event was applied
- **Output**: one line per step; full child output in a temp-dir log. Exits 1 on any stop/failure
- **Flags**: `--dry-run` · `--since YYYY-MM-DD`
- A namesake stop is resolved by running `backfill-event.js --ufc-id <event> --new-fighter <fighter ufc_id>` by hand, then re-running weekly

### `src/scrapers/backfill-event.js` — Single-event backfill from ufcstats
- **Flags**: `--ufc-id ID` · `--apply` · `--title "0,3"` · `--new-fighter ID[,ID]` (create a verified same-name namesake; slug gets `-2`, `-3`, ...) · `--summary-json PATH` · `--skip-results` · `--interim "1"` · `--upcoming` (scheduled card: syncs kept bouts' weight class / title flags / `time_format`, 5 rounds for bo0 and title bouts; no results, no is_complete) · `--source-json PATH` (with --upcoming; Wikipedia card, fighters matched by name only, never created)
- ufcstats shows belt icons on TUF / Road to UFC tournament finals too; the dry run reads each belt bout's page title and only counts "UFC … Title Bout"

### `src/scrapers/upcoming-cards.js` — Scheduled cards + prediction log (manual)
- **Source**: ufcstats upcoming listing; Wikipedia (List of UFC events + event pages) if ufcstats fails or `--wiki`
- **Per event**: `backfill-event.js --upcoming` dry run → apply only if clean (same rules as weekly: no abort/conflict/VARIANT/suspect create, count matches) → `sherdog-pro-records.js --ids` for created debutants → `log-predictions.js --void-missing`
- **Flags**: `--apply` · `--days N` (default 14) · `--ufc-id ID[,ID]` · `--wiki` · `--no-log`
- Re-run whenever a card changes: new bouts are inserted and logged, bouts that left are deleted and their picks voided, locked picks are untouched

### `src/scrapers/log-predictions.js` / `grade-predictions.js` — Predictions log
- `prediction_log` (migration `2026-10-15-prediction-log.sql`): one row per scheduled bout, written BEFORE the event, **first pick locked** (unique on event + unordered pair). DB triggers refuse inserts after the event date, any change to prediction columns, any re-write of a grading column, and all deletes — there is no in-place correction; that is the point
- log: `generatePrediction` with the fight's weight class and rounds (`time_format`), no narrative, no cache. Pick = higher win %, method = that side's likeliest of KO/TKO/SUB/DEC. Flags `--event-id` · `--upcoming` · `--void-missing` · `--dry-run`
- grade: matches by event + unordered pair once `is_complete`; draw / NC / cancelled / matchup changed → `void` (not scored). Served by `GET /api/track-record` → `TrackRecordPage` (`/track-record`)
- **Toss-up rule (user decision 2026-10-15, fixed before any pick was graded — do not move the line after results come in)**: a graded pick with `predicted_win_pct < 52` is labelled "Toss-up" and excluded from accuracy (overall, per confidence level, per-event hit counts), but stays in log loss, Brier and calibration. `TOSSUP_PCT` in `routes/trackRecord.js`; the rule is stated on the page. First two logged cards: 5 of 24 picks are toss-ups

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
- **`--ids ID,ID`**: exactly these fighters even when `pro_wins` is set — backfill-event.js fills `pro_*` from ufcstats for debutants, so the default pass never gives them a `sherdog_id`
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

**Shipped model: `model-v7.json`** (written by `trainModel.js`, read by `predictionEngine.js`; the v6 feature set — v4 + the two late-replacement features, `proRecordSource: 'sherdog'` — plus `glicko_scaled` from the unified Glicko-2 replay, see "Glicko-2 (Phase 11)" below). Serving reads Glicko state from the precomputed `glicko_ratings` table (never from `sherdog_fights`).
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
"thin sample" note under 30 min. Cache rows are keyed by `model_version` (`v6`); older
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
- **Market baseline**: de-vigged closing consensus, from `data/market-lines.json`
  (BestFightOdds closing range per side → mean implied, proportional de-vig; best price =
  low end of the range) and, for fights without a line there, the `odds` table (prefers
  `line_type='closing'`, else latest line per bookmaker, averaged across books). Lines are
  oriented to DB `fighter1_id`; the harness re-orients through the row's hash flip. Reports
  market / model / 50-50 logit blend log loss on the same fights, pick agreement, and
  flat-stake ROI (bet when model p × decimal close > 1) at the consensus and best close
  with a bootstrap 95% CI, per fold and pooled.
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
| `phase1-2.json` | 18 features (see below); Elo K 100 ×1.5 finishes; min-prior 0 | 64.8% / logloss 0.6298 | 19/27 |
| `phase2-age-elo.json` | **shipped v4**: the 18 + `age_elo`; size prior in sanity | 65.2% / logloss 0.6283 | 25/27 |
| `phase6-market.json` | shipped v4 + market baseline (2,480 fights with a closing line) | model 0.6274 vs market 0.6064 | 25/27 |
| `phase8-short-notice.json` | v5: v4 + `replacement`, `notice_days` (training-only context) | 0.6284 on this subset; 0.6385 vs 0.6415 on all 3,929 | 25/27 |
| `phase10-honest-record.json` | v6: v5 features, `proRecordSource: sherdog` (exact as-of pro record) | 0.6395 on all 3,929; market gap +0.0359 on 3,875 with a line | — |
| `phase11-glicko-v7.json` | **shipped v7**: v6 + `glicko_scaled` (unified Glicko-2, finish ×1.5) | 0.6345 / 64.3% on all 3,929; market gap +0.0307 on 3,875 with a line | 25/27 |

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

**Size / weight-cut prior (`sizePrior.js`, user decisions 2026-10-12, v2 bout-weight-aware).**
A hand-set log-odds shift applied ON TOP of the model's skill estimate at serving time and
in the sanity set, never inside the fold evaluation. Both fighters' NATURAL divisions (modal
weight class) and the BOUT limit sit on the ladder 115/125/135/145/155/170/185/205/265
(fractional rung for a catchweight, so both effects apply proportionally). Each fighter
moves from natural to bout weight and pays a penalty; net shift toward A = penalty(B) −
penalty(A), so equal moves cancel:
- moving UP u divisions: 0 for u ≤ 1; `1.10·x + 0.05·x²`, x = u − 1 → 1.15 / 2.40 / 3.75 /
  5.20 at 2 / 3 / 4 / 5 (Topuria at heavyweight → Ngannou 99%; Makhachev at MW vs Chimaev
  37%, vs Strickland 68%).
- cutting DOWN d divisions: 0 for d ≤ 1; 2.0 at 2 ("extreme cut"); 5.0 at 3 and +1.5 per
  further division ("not a realistic weight cut" — odds flip to the fighter at natural
  weight, with that wording in the factor); knots interpolate linearly.
- DJ (125) vs Chimaev (185): flyweight 99.8% DJ, bantamweight 99.1% DJ, welterweight 99.6%
  Chimaev, middleweight 99.9% Chimaev. Skill alone says Chimaev 85.7%.
Shown as the first key factor ("Size adjustment —" or "Weight cut not realistic —
assumption, not learned from fight data: … moved X from a% on skill alone to b%");
confidence forced to `low` when either fighter moves ≥ 2 divisions either way. **Default bout
weight when the request gives none = the HEAVIER fighter's natural division** (engine and
sanity set alike), so the default is slot-order independent and A-vs-B still mirrors B-vs-A;
it used to be fighter1's division, which would have made DJ-vs-Chimaev and Chimaev-vs-DJ
disagree. Sanity set 25/27 (the two misses are same-division direction-only pairs).

**Mirror symmetry.** P(A beats B) must equal 1 − P(B beats A). Two things broke it: a
fitted mean in standardization (fixed: `mu = 0`, `sigma` = RMS, in both `trainModel.fit`
and `evaluate.fitAndScore`) and a fitted intercept (fixed: `trainLogistic` defaults to
`fitIntercept: false`; the hash flip makes the true intercept zero). Held-out logloss was
unchanged by both (0.6298). Van vs Yan now reads 58.0/42.0 in both orders.

**Why size cannot be learned from UFC data:** among 6,390 training rows with both natural
divisions known, 4,764 have no gap; with a 1–15 lb gap the naturally bigger fighter wins
49.5% (n=1,185), 16–30 lb 47.6% (n=292), 31–60 lb 39.4% (n=127). Cross-division bouts are
matchmade to be competitive, so "bigger wins" is absent from the evidence, and the
hypothetical cross-weight sanity pairs (Ngannou–Topuria, Miocic–Johnson,
Pereira–Dvalishvili) are out of distribution for any model trained on real cards. Hence
the hand-set prior above rather than a learned feature.

**Age (investigated 2026-10-12, model unchanged).** The data backs the age weight: the
younger fighter wins 53/57/61/68% at gaps of 0–3/4–6/7–9/10+ years (n=3,035/2,567/1,408/760),
stronger in fly/bantamweight at big gaps (75% at 10+). Held-out, the model UNDER-favours the
younger side by 2–7 points in every gap bucket (age-only slope −0.059 log-odds/yr, full model
−0.046). The effect flattens only when the older fighter is elite (Elo ≥ 1900: 50.8% at
7–9 yrs, n=61).

**`age_elo` = (age − 30)·(elo − 1500)/100 — PASSED the gate and is shipped (feature 19):**
pooled 0.6298 → 0.6283, mean Δ −0.0014, worse only in 2026 (+0.002); vs Phase 0 −0.0189.
Coefficient is NEGATIVE (−0.099): an older fighter carrying a high rating does *worse* than
age and Elo separately predict — Elo is backward-looking and overstates aging champions.
So it did not soften the age penalty for Yan; Van vs Yan went 58.0% → 62.4% for Van.
Report: `reports/phase2-age-elo.json` (sanity 25/27). Deployed 2026-10-12; production
verified: Van vs Yan 62.4/37.6 both orders, Topuria vs Ngannou 1/99 with the size factor.

**Phase 4 — style (2026-10-12): engine built, no feature shipped.** `styleEngine.js`:
`styleProfile(snapshot)` → continuous axes (distance/clinch/ground share, TD/15, sub/15,
control %, pace) + a label (Striker, Pressure striker, Counter striker, Clinch fighter,
Wrestler, Grinder, Submission grappler, Submission hunter, Balanced, Unknown) from ANY
snapshot, so it is point-in-time whenever the snapshot is — unlike `fighters.primary_style`
(`assign-styles.js`), a current-career heuristic backfilled onto every historical fight,
which is leaky and should not be used for modelling. `buildStylePairHistory()` replays
fights in date order and records, per fight, the pre-fight win rate of style A vs style B.
Gated features (all in `TRAIN_EXCLUDED`): `style_distance/clinch/ground/ctrl` −0.0005 but
worse in 3 folds; `style_pair_edge` +0.0002; pairwise `pair_td_threat` (own TD/15 × opp
TD-defence gap) and `pair_strike_threat` +0.0006; all seven together +0.0003. The style
record itself is real but small (Wrestler vs Balanced 63%, Striker vs Submission grappler
42%, n≈170–640) and already expressed by td_avg / sub_avg / defence features. Pairwise
features live in `features.PAIR_FEATURES` and are computed in `diffVector` from both sides
(antisymmetric, mirror-safe). Reuse: `predictionEngine.generatePrediction` returns
`style_profiles: { fighter1, fighter2 }` (not cached) and `GET /api/styles/profile/:slug`
serves one fighter's current profile — Compare, Predict and the Styles page should read
these instead of `primary_style` / `style_matchups`.

**Phase 5 — model choice (2026-10-12): logistic stays.** `gbm.js` is a dependency-free
histogram gradient booster (Newton leaves, L2, depth limit, subsampling, optional monotone
constraints) run through the harness with `--model gbm` on the SAME folds and standardized
inputs as the logistic model (`--l2` sweeps the logistic penalty). Results vs the shipped
19-feature logistic (0.6283): logistic L2 1e-4 ±0, 1e-2 +0.0003, 1e-1 +0.0060; GBM
300×depth-3 +0.0086 (worse in 8/8 folds), on all 41 features +0.0101, stumps 600×depth-1
+0.0069, depth-2 400 rounds lr 0.03 l2 20 +0.0067, heavier regularization worse still
(+0.011 to +0.020). Even an additive booster cannot beat the linear fit, so the structure
is near-linear at this sample size and the plan's ship rule (GBM must win by ≥ 0.005 in
every fold) is nowhere near met. Keep logistic, L2 = 1e-3, zero intercept.

**Phase 6 — market benchmark (2026-10-12): the model is 0.021 log loss BEHIND the
closing line and adds nothing to it.** Closing lines come from BestFightOdds fighter
pages via `scrapers/bestfightodds-lines.js` (INTERNAL BENCHMARKING ONLY — the lines live
in `src/ml/data/market-lines.json`, are read by `evaluate.js` alone, and must never be
served by a route or shown on the site; BFO's terms are a bare "as is" disclaimer and
robots.txt allows all, scrape pace 2 s/request). One fighter page lists open + closing
range (min…max across books) + event + date for every bout, so one page covers both
sides of each of that fighter's fights. Identity is resolved along the FIGHT GRAPH: a
page is accepted for a DB fighter only when its rows match that fighter's DB fights by
date ±1 (BFO shows the US-evening date) and opponent name; each matched row then pins
the opponent's BFO id to the DB opponent id exactly, so same-name fighters (Anthony
Romero ×2, Bruno Silva ×2, Mike Davis, Jean Silva, Joey Gomez, Michael McDonald) are
never name-matched. Raw HTML is cached under `backend/.cache/bestfightodds` (gitignored)
so runs are resumable; `--rematch --limit 0` re-parses the cache offline after a matcher
change. Coverage: 7,615 / 7,682 decided fights since 2010 (99.1%; every fold year
≥ 97%, 2019 complete), ~1,500 page fetches over three resumed runs (one killed by the OS
memory guard, one by a suggest-API 500 on a diacritic name — both now survivable). The
67 gaps: 58 where both pages parsed but BFO lists the bout on a DUPLICATE profile (Zhang
Weili's mapped page stops in 2021; Figueiredo's starts in 2020), 13 fighters whose
suggest candidates never date-verified. Cancelled/rebooked bouts stay on BFO under the
original opponent (the bulk of `unmatchedBfoRows`). Cross-check vs the Kaggle "Ultimate
UFC Dataset" (`crosscheckMarketLines.js --csv ufc-master.csv`, GitHub mirror, no login):
7,177 rows, 95.0% match a DB fight; of 6,295 fights with both sources 93.7% of Kaggle
lines fall inside the BFO closing range and 4.2% within 0.03 implied prob; the 2.1%
"far" rows are Kaggle corner swaps / bad rows (Nunes–Tate, Makhachev–Moicano) and 2020
rows that look like openers. Harness (`reports/phase6-market.json`, shipped v4 setup):

| on the 2,480 scored test fights 2019–2026 with a line | market (de-vigged close) | model v4 | 50/50 logit blend |
|---|---|---|---|
| accuracy | 67.8% | 65.5% | — |
| log loss | 0.6064 | 0.6274 (+0.0210) | 0.6079 |
| 2021+ only (1,932 fights) | 0.6024 | 0.6241 (+0.0217) | 0.6040 |

Model beats the close in ONE fold (2021: 0.6351 vs 0.6364) and agrees with it on the
pick 77% of the time. Flat stake, 1 unit whenever model p × decimal close > 1: at the
consensus close 2,133 bets, −74 units, ROI −3.5% (95% CI −8.5% … +1.8%); at the best
available close 2,354 bets, +36 units, +1.5% (CI −3.9% … +6.8%); edge ≥ 5% filter does
not help (−4.4%). Verdict against the plan's rules: NOT "beats the market"; "sellable"
rule (within 0.02 of the close) missed by 0.001; far from "drawing board" (≥ 0.04).
The blend being no better than the market alone is the key fact: everything the model
knows is already priced in. Harness flags: `--market PATH` (default the lines file),
`--no-market`.

**Short-notice replacements — SHIPPED as model-v5 (2026-10-13).** Source:
Wikipedia event pages, "Background" prose, via the MediaWiki wikitext API
(`scrapers/wiki-short-notice.js`, descriptive User-Agent, 1.5 s/request, 429 backoff,
cache `backend/.cache/wiki-short-notice`, gitignored). Parses "replaced by X" / "X stepped
in / filled in / took the fight"; notice days from the same or previous sentence (explicit
date = the withdrawal announcement, "two weeks before", "day of the weigh-ins"); each name
is matched to a fighter on that DB card (full name, else unique surname). Output: the
`fight_replacements` table (`src/db/migrations/2026-10-13-fight-replacements.sql`; one row per
fight: fighter_id, days, cue, sentence; `--reparse` rebuilds it from the page cache), read by
`trainModel.loadShortNotice` and passed into `buildDataset` as `shortNotice`. TRAINING DATA ONLY. Coverage: 740 events since 2005 → 731 mapped, 708 with a
Background section; 1,247 mentions → 975 matched (unmatched are mostly bouts later
scrapped); 948 fights with a replacement, 424 with a notice time, 243 ≤ 21 days.
Replacements win 40.4% (n=928), ≤ 21-day replacements 34.4% (n=241). `npm run weekly` reruns
the scraper (`--since` the first applied card's year; old pages come from the cache) and upserts
the new cards' rows — nothing to commit.

Features (`features.js`, filled by `trainModel.noticeFor`): `replacement` (0/1) and
`notice_days` (capped at 60; 60 = full camp; replaced with unknown timing = 21). At serving
both are null → diff 0, so every hypothetical assumes a full camp and the Predict page is
unchanged (sanity 25/27 before and after; no FACTOR_META, the null filter drops them). A
binary `short_notice` (≤ 21 days) was redundant (+0.0003 if removed, 6/8 folds) and deleted.
Gate vs the shipped 19 (full 3,929-fight scoring, baseline 0.6415): `replacement` alone
−0.0023 (0 folds worse), `notice_days` −0.0028 (1), both −0.0030 (1: 2023 +0.0010) →
pooled 0.6385 (64.0%). The gain is entirely on thin-history rows: on the min-prior-2 subset
v5 is 0.6284 vs v4 0.6283 (+0.0003 mean, 4 folds worse). Coefficients: replacement +0.137,
notice_days +0.283 (standardized). Market benchmark rerun (`reports/phase8-short-notice.json`,
2,480 fights with a line): market 0.6064, model 0.6277 (+0.0213, was +0.0210), blend 0.6079,
pick agreement 77.7%, ROI −2.7% at the consensus close / +2.3% at the best close (both CIs
span 0) — the market verdict is unchanged. `model-v4.json` deleted; cache rows are keyed
`v5` (fight_predictions cleared before deploy).

**Decision quality in Elo (2026-10-13): gated, nothing shipped.** `eloEngine.js` takes
`decision` = `none` | `method` (U-DEC ×1, M-DEC ×midpoint, S-DEC ×floor on K) | `cards` (K ×
floor + (cap−floor)·dominance, dominance = mean winner margin per card per round from
`judge1-3_score`, 29-28 ×3 = 0.33, shutout = 1, 97% of decisions since 2001 have cards) |
`score` (same dominance as a fractional result instead of a K multiplier), with
`decisionFloor` / `decisionCap`; config keys `eloDecision` / `eloDecisionFloor` / `eloDecisionCap`,
harness flags `--elo-dec` / `--elo-dec-floor` / `--elo-dec-cap`. Against the shipped v4 setup
(3,929 scored fights, baseline 0.6415): method floor 0.5 −0.0003 (3 folds worse), cards
0.25/1.25 −0.0010 (3), score 0.5/1 −0.0010 (2), score 0.25/1 −0.0012 (2), score 0/1 −0.0011 (4);
nine variants in all, every one worse in 2–4 folds (2021–22 gain, 2020 and 2026 lose), so
none passes and `eloDecision` stays `none`. Volkanovski vs Evloev moved from 37.7% to
39–51% Volkanovski depending on the variant. **MMADecisions.com media scorecards were NOT
scraped**: its robots.txt allows only a named list of search/social crawlers and ends with
`User-agent: * Disallow: /`; there is no terms page. Do not build a scraper for it.

Phase-1 findings (2026-10-12): shrinkage alone −0.002, pro record alone −0.0027, layoff cap
−0.0006, win-rate shrink −0.0005, decay and clipping ≈0 alone but decay helps in
combination; `stats_minutes` as a feature failed the gate (+0.0006). Training on debutants
costs +0.0004 on the experienced subset and makes the model valid for the full serving
population (3,929 test fights, 62.6% / 0.6495). Ablation under v4 config: `age` (+0.0083
if removed), `str_acc`, `str_def`, `layoff_days`, `pro_fights` pass; `pro_win_rate`
(+0.0014), `td_avg` (+0.0026), `sapm` (+0.0020) help on mean but fail the fold count.
Cross-weight sanity pairs still fail — that is Phase 3 (size / weight-class features).

**Thin-record fighters (2026-10-14).** `evaluate.js` prints model vs market log loss by
prior UFC stats-fights of the thinner side whenever market lines are loaded (shipped v5
config, 3,929 scored fights): debutant bucket n=799 market 0.5757 / model 0.6569
(+0.081), 1–2 +0.027, 3–5 +0.026, 6+ +0.016 — the market's best bucket is the model's
worst. The harness DEFAULTS are knobs-off; to reproduce the shipped setup pass
`--min-prior 0 --score-min-prior 0 --shrink 30 --half-life 1095 --layoff-cap 730
--win-shrink 2 --clip 3 --elo-k 100 --elo-finish 1.5 --features <the 21 in model-v5.json>`
(pooled 0.6385). `reports/phase9-thin-gap.json`.
- **Amateur record**: `amateur_wins/losses` are 0 on every fighter row (the sherdog-amateur
  backfill never populated them) — not gateable until the Sherdog history is in.
- **Contender Series** (`scrapers/wiki-dwcs.js` → `dwcs_results`, migration 2026-10-14;
  falls back to `.cache/wiki-dwcs/dwcs-results.json` until the table exists): 10 seasons,
  474 bouts, 778 appearances matched (693 fighters), 1,768 decided UFC fights with an
  alumnus. Features `dwcs`, `dwcs_won`, `dwcs_finish`, `dwcs_days_to_debut` ALL FAILED the
  gate (mean +0.0002…+0.0009, worse in 3–6 of 8 folds; debutant gap unchanged) and stay in
  `TRAIN_EXCLUDED`. Tapology is NOT used (its robots.txt disallows Claudebot and the site is
  Cloudflare-fronted).
- **Sherdog fight history** (`scrapers/sherdog-history.js` → `sherdog_fights`, migration
  2026-10-14; cache `.cache/sherdog-history/<sherdog_id>.html`, `progress.json`, fallback
  `sherdog-fights.json`): one profile page per fighter with a `sherdog_id` (4,103),
  1.5 s/request, resumable, `--reparse` offline, wrong-profile guard as in
  sherdog-pro-records.js. TRAINING ONLY — never served or displayed (Sherdog ToU forbids
  aggregating content for use elsewhere; this is internal benchmarking like the BFO lines).
  Gate candidates (`TRAIN_EXCLUDED`, pending data): `regional_finish_rate`,
  `regional_opp_quality` (opponents' own as-of win rate, only when the opponent is a UFC
  fighter with a loaded page; unknown = 50), `regional_opp_ufc_share`, `pro_record_quality`
  = (pro_win_rate − 50) × min(pro_fights, 30) / 100; plus config `proRecordSource`
  (`--pro-record sherdog`) which swaps `pro_win_rate` / `pro_fights` to the exact as-of
  record instead of today's pro record minus later UFC results.

**Honest pro record — SHIPPED as model-v6 (2026-10-14).** Scrape done: 4,103 pages,
88,450 `sherdog_fights` rows (4,064 fighters); 82% of scored test fights and 75% of
debutant fights have Sherdog data on both sides. Gate under the shipped flags (3,929
scored fights 2019–2026):
- `--pro-record sherdog` alone vs the v5 approximation: 0.6385 → 0.6395 (+0.0008 mean,
  6/8 folds WORSE). The approximation (today's `pro_wins/pro_losses` minus later UFC
  results) still contains every non-UFC bout the fighter had AFTER the fight, i.e. future
  information, which is why it scores better. User decision: ship the exact record as the
  honest baseline and accept the paper regression. Nothing else in v6 changed (same 21
  features, same knobs). `model-v5.json` deleted; cache rows keyed `v6`.
- Regional features vs the honest baseline (0.6395): `regional_opp_quality` −0.0012 but
  2 folds worse (2019 +0.007); `regional_opp_ufc_share` −0.0006 (2 folds);
  `regional_finish_rate` −0.0002 (4); `pro_record_quality` +0.0002 (6); all four together
  −0.0016 (3 folds: 2019 +0.004). Against the leaky v5 baseline the same picture
  (opp_quality −0.0015, 2 folds; all four −0.0021, 2 folds). NONE passes the ≤1-fold rule;
  all four stay in `TRAIN_EXCLUDED`. Debutant gap moves 0.081 → 0.075 at best.
- Market benchmark for v6 (`reports/phase10-honest-record.json`, 3,875 scored fights with
  a line, ALL experience levels — the earlier +0.021 figures were on the min-prior-2
  subset): market 0.6026, model 0.6385, **gap +0.0359**; blend 0.6099; pick agreement 75.5%;
  flat-stake ROI −5.9% at the consensus close (CI −10.3% … −1.6%), −1.2% at the best close
  (CI spans 0). By bucket: debutants +0.081, 1–2 +0.029, 3–5 +0.026, 6+ +0.018.
- `npm run weekly` now runs `sherdog-pro-records.js` (profile + `sherdog_id` for fighters
  with `pro_wins IS NULL`, i.e. the new cards' debutants) and then `sherdog-history.js`
  (pages for every fighter with a `sherdog_id` not yet in `progress.json`) after
  wiki-short-notice.js, so the as-of record stays current for retraining. A fighter whose
  Sherdog profile is not found keeps a null pro record → `pro_win_rate`/`pro_fights` null
  → those features drop out of the diff for that bout, at serving and in training alike.

**Glicko-2 (Phase 11) — SHIPPED as model-v7 (2026-10-15).** `glickoEngine.js` is a
date-batched Glicko-2 replay with the same `summaryAsOf(fighterId, date)` contract as
`eloEngine` (state before any fight on that date, RD inflated for inactivity; `glickoEngine.test.js`
is the ordering guardrail — run `node src/ml/glickoEngine.test.js` after touching it). Seeds:
`none` (1500/350), `record` (first state from the pre-UFC Sherdog record), `unified` (the replay
itself includes every non-UFC Sherdog bout of fighters with a page; opponents without a page are
their own nodes keyed by Sherdog id; a Sherdog row duplicating a DB fight ±1 day is dropped).
Config keys `glickoSeed` / `glickoTau` / `glickoRd0` / `glickoFinishMult` (+ `glickoVol0`,
`glickoPeriodDays`, `glickoSeed*`); harness flags `--glicko` / `--glicko-tau` / `--glicko-rd0` /
`--glicko-finish`. Features: `glicko`, `glicko_rd`, `glicko_scaled` (PAIRWISE: rating gap /
√(RD_a² + RD_b²)), `glicko_p` (logit of the Glicko expected score), `age_glicko`.
- **Gate (v6 baseline 0.6395, 3,929 scored fights):** `glicko_scaled` under `--glicko unified
  --glicko-finish 1.5` → **0.6345**, mean −0.0051, worse only in 2021 (+0.0023) — PASSES. `none`
  and `record` seeds fail (3–4 folds worse); tau / RD0 grid are ties (defaults 0.5 / 350 kept);
  finish multiplier off is worse in 8/8 folds. `glicko_rd`, `glicko_p`, `age_glicko` are zero in
  leave-one-out and `glicko` adds nothing beyond `glicko_scaled`; all four stay in `TRAIN_EXCLUDED`.
  Reports `reports/phase11-glicko-*.json`. Shipped set = the 21 of v6 + `glicko_scaled` (22);
  `glicko_scaled` is the largest standardized coefficient (+0.398, ahead of age −0.311).
- **Market (`reports/phase11-glicko-v7.json`, 3,875 fights with a line):** market 0.6026, model
  0.6334, **gap +0.0307** (v6 +0.0359); blend 0.6075 (still no better than the market); pick
  agreement 76.5%; ROI −4.6% at the consensus close (CI −8.8% … −0.4%), −0.3% at the best close
  (CI spans 0). Debutant gap +0.081 → **+0.0685** (1–2: +0.020, 3–5: +0.022, 6+: +0.021).
- **Serving reads a table, not Sherdog.** `computeGlickoRatings.js` runs the unified replay with
  `trainModel.TRAIN_CONFIG` and upserts one row per fighter into `glicko_ratings` (migration
  `2026-10-15-glicko-ratings.sql`: rating / rd / volatility after the last rated bout, fight
  counts, `last_fight_date`, the engine config). `predictionEngine.getData` loads it through
  `glickoEngine.ratingsFromTable`, which inflates the stored RD to today exactly as the replay
  inflates to a fight date (verified identical to the full replay for all 4,539 fighters); an
  unknown fighter gets the fresh 1500/350 state, as a debutant does in training. If the table is
  missing or empty the engine warns, serves with the glicko features neutral and retries in 5
  minutes instead of 6 hours. `npm run weekly` runs the precompute after sherdog-history.js. The
  Sherdog rows stay internal: only a derived rating leaves them, and it is never displayed.
- `model-v6.json` deleted; cache rows keyed `v7` (`fight_predictions` cleared before deploy).
  **Logged picks in `prediction_log` stay v6** — the log is write-once by design.
