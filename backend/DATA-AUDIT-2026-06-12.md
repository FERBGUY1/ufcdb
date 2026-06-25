# UFCDB Comprehensive Data Audit — 2026-06-12

**Scope:** Full-database integrity audit + Wikipedia verification of a random 50-event
sample (10 per era, seed 20260612) + Sherdog pro-record spot-check.
**No fixes applied** beyond the requested `fix-fighter-records.js` resync (2,672 fighters)
and the pro-records scraper re-run. All findings below are report-only.

**Database at audit time:** 8,638 fights · 4,455 fighters · 786 events · 14 weight classes.

**Tools (all report-only, reusable):**
- `src/audit-db.js` — DB-only integrity audit (output: `audit-db-output-u8.txt`)
- `src/audit-wiki-sample.js` — Wikipedia 50-event verification (output: `audit-wiki-output.txt`, `audit-wiki-findings.json`)
- `src/audit-sherdog-spotcheck.js` — Sherdog pro-record re-verification

---

## CRITICAL

### C1. ~120 fighters with V surnames are missing, along with all their fights
The May 2026 re-seed lost almost the entire V-surname range. The DB has **32**
V-surname fighters vs ~140–160 expected (W has 140, T has 163), and every one of
the 32 was created 2026-05-21 or later by newer scrapers re-adding currently
active fighters. Confirmed missing entirely: Brandon Vera, Bobby Voelker, Joe
Vedepo, Matt Veach, James Vick, Hugo Viana, Jamie Varner (and by extension every
historical V fighter not active since 2022).

Knock-on effects, confirmed by the Wikipedia sample:
- **~16 of 18 missing fights** in the 50-event sample involve a V-surname fighter
  (Vera×3, Voelker×2, Vedepo, Veach, Vick, Viana, Varner, Vannata, Vettori,
  Vargas, van Arsdale, Viana/Whitmire, Vera/Ewell). Extrapolating ~3.5% of
  sampled fights missing → likely **300+ fights missing DB-wide**.
- Re-added V fighters have incomplete records (e.g. Lando Vannata stored 0-3;
  his Teymur fight among others is absent).
- Opponents of missing V fighters are also undercounted (their wins/losses
  against V fighters don't exist in the fights table).
- Many of the 198 "bout_order gaps" events (Section M3) are gaps left where a
  V-fighter bout should be.

**Suggested fix path (for review):** re-import fighters + fights for the missing
range from Tapology/Wikipedia, then re-run `fix-fighter-records.js`,
`fix-bout-order.js`, `fix-title-fights.js`.

### C2. Three 2022 events were never scored — 25 fights stuck on result='upcoming'
All three are marked `is_complete=true` yet most of their fights have no result:

| Event | Date | Unscored / total |
|---|---|---|
| UFC Fight Night: Hermansson vs. Strickland | 2022-02-05 | 12 / 13 |
| UFC Fight Night: Ortega vs. Rodriguez | 2022-07-16 | 8 / 12 |
| UFC Fight Night: Kattar vs. Allen | 2022-10-29 | 5 / 11 |

Roughly 50 fighters' UFC records silently exclude these bouts (the record resync
only counts completed fights). The few fights on these cards that *do* have
results include two impossible **KO/TKO + result='draw'** rows (fights `3c7f1ef9`,
`f2dbd39b`) — the partial import that touched these events wrote bad data.
Additionally Melissa Gatto vs Viktoriia Dudakova (Blanchfield vs. Fiorot,
2024-03-30) is stuck upcoming, but that bout was genuinely cancelled — it should
be deleted, not scored.

---

## HIGH

### H1. 69 fights with result=NULL — 51 are likely phantom/cancelled bouts
- **51 rows** on past 2023–2025 events, all created in the 2026-05-28 phantom
  window, with null method/result. The Wikipedia sample confirmed 5 of 5 checked
  do not appear on the event's card (e.g. Miles Johns vs Cody Garbrandt at
  Magny vs. Prates; Stewart Nicoll vs Rei Tsuruya and Nyamjargal Tumendemberel
  vs HyunSung Park at UFC 312) — these are announced-then-cancelled bouts the
  scraper imported as real. Candidates for deletion after review.
- **18 rows** on the upcoming 2026-07-18 Fight Night (created 2026-06-01) have
  `result=NULL` where the convention requires `result='upcoming'`.

### H2. UFC-record fields hold full career records for the 1,765 zero-fight fighters
`fix-fighter-records.js` only touches fighters that appear in the fights table,
so the 1,765 fighters with no fight rows keep whatever the seed wrote — which is
their **career** record stuffed into the UFC `wins`/`losses` fields (Shannon
Ritch "UFC 56-83", Fedor Emelianenko "UFC 36-5", Saad Awad "UFC 20-9", etc.).
60 fighters exceed 40 "UFC" fights; a couple are legitimately large (Jim Miller
28-18, Andrei Arlovski 23-18) but nearly all zero-fight cases are contamination.

This is also the root cause of the **pro-records scraper skips**: its guard
compares the Sherdog record against the polluted "UFC record" and wrongly skips
correct profiles (e.g. Jose Alday, Sherdog 13-7 vs stored "UFC 14-6").

### H3. Sherdog matching hits namesakes
The scraper's strict full-name match selects wrong same-name profiles when the
real fighter isn't found first: Saad Awad → "Moaz Saad Awad" (0-0), John Howard
→ "Howard John Steer", Robert McDaniel (0-0), etc. The record-size guard caught
these (they appear as SKIPs), but profiles that *passed* the guard may still be
namesakes. See the spot-check section below for measured accuracy.

### H4. Fight result/method errors confirmed against Wikipedia (sample of 497 fights)
- UFC 17 (1998): Andre Roberts vs Harry Moskowitz — DB `U-DEC`, actual **KO (elbow)**.
- UFC FN Henderson vs Khabilov (2014): Jon Tuck vs Jake Lindsey — DB `KO/TKO`,
  Wikipedia **Submission (heel strikes to the body)** (verbal submission).
- UFC Ultimate Japan (1997): Couture vs Smith round mismatch (DB R3, wiki R1 —
  era used regulation + overtime format); Abbott vs Anjo (DB R2, wiki R1);
  missing the Sakuraba vs Silveira NC semifinal (DB has only the rematch/final).
- UFC 1: missing the Jason DeLucia vs Trent Jenkins alternate bout (both
  fighters exist in DB).
- The 2 KO/TKO "draws" from C2.
- Overall sampled error rates: method 8/497 (1.6%), round 2/497, winner 0/497
  (the 2 flagged winner mismatches were name-variant false positives —
  Lim Hyun-gyu = Hyun Gyu Lim; Yana Kunitskaya = Yana Santos).

---

## MEDIUM

### M1. Draw/method encoding inconsistencies (79 draws total)
57 draws store the *decision type* instead of the documented `'Draw'` method:
M-DEC 35 · S-DEC 15 · U-DEC 7. (Verified against Wikipedia in 5 sampled cases —
the results are correct, only the method encoding deviates from the convention
in CLAUDE.md.) Remaining draw methods: CNC 13, Overturned 5, Other 2, KO/TKO 2
(the C2 errors). Decide on one canonical encoding (e.g. `Draw` +
`method_detail='majority'`) before fixing.

### M2. 50 fights with non-standard method strings
- Unnormalized text from some importer: `Submission` ×14, `Decision` ×26, `TKO` ×1
  (2012–2025 events, should be `SUB`/`U-DEC|S-DEC|M-DEC|DEC`/`KO/TKO`).
- **Fighter surnames in the method column** ×8 (`Oleksiejczuk`, `Montes`,
  `Chikadze`, `Holland`, `Bashi`, `Cannonier`, `Gandra`, `Coria`) — all on
  upcoming June–July 2026 events, created 2026-06-01/02. A recent import wrote
  the opponent's name into `method`; the scraper that ran those dates needs a fix
  before its next run.
- `Other` ×2 on Ken Shamrock fights at UFC 5/7 (era quirk, verify manually).

### M3. Bout order / card position integrity
- **11 fights** violate the `result='win' → winner_id == fighter1_id` convention
  (winner stored in fighter2 slot) — affects EventPage display of winners.
- 70 events with duplicate bout_order across sections; 198 events with gaps
  (many caused by C1 deletions); 18 events with no bout_order=0; 10 partial;
  5 fights with card_position but NULL bout_order.
- Wikipedia sample: **94/497 (19%) card_position mismatches**. Mostly
  prelim ↔ early_prelim boundary disagreements, but several main_card ↔ prelim
  swaps (e.g. Pereira vs Bruno Silva at FN Santos vs Ankalaev: wiki main card,
  DB prelim; Mason Jones vs Stephens at FN Sandhagen vs Figueiredo: wiki main
  card, DB prelim). 11 events had bout-order inversions vs the wiki card order.
  Suggests `fix-bout-order.js` section assignment drifts from Wikipedia's current
  page structure — worth re-running with `--force` after C1 is resolved.

### M4. Duplicate fighters (8 same-name pairs analyzed)
| Pair | Verdict |
|---|---|
| Michał Oleksiejczuk `f28122d1`(profile, 0 fights) / `3f07e3ad`(18 fights) | **Same person, split rows — merge** (profile data on one, all fights on the other) |
| Marek Bujło `a953d2f5`(profile) / `37ecd177`(1 fight) | **Same person, split rows — merge** |
| Mike Davis `f43d5b46`(7 fights) / `413e8677`(empty) | Same person — delete empty row |
| Joey Gomez `e8cd78ad`(155 lb, 0 fights) / `b06f3205`(135 lb, 2 fights) | Different DOBs — likely distinct, verify |
| Michael McDonald (1991 BW vs 1965 LHW) | Distinct people |
| Jean Silva ("Lord" vs "White Bear") | Distinct people |
| Tony Johnson (HW vs LHW, both 0 fights) | Distinct people |
| Bruno Silva (FW/MW) | Known distinct ✓ |

### M5. Stale event flags
4 events `is_complete=true` with upcoming fights (the C2 trio + Blanchfield vs.
Fiorot). The non-UFC-looking event "Ortiz vs Shamrock 3: The Final Chapter
(2006-10-10)" is a real UFC event (UFC Fight Night 6.5) — name only lacks the
UFC prefix.

---

## LOW / INFORMATIONAL

- **Weight class coverage:** 624 fights have NULL `weight_class_id` (507 on
  2022+ — the API-Sports importer doesn't set it; 116 pre-2000 where weight
  classes didn't exist; 1 in 2000-2009). 1,860 fighters lack
  `primary_weight_class_id` (mostly the zero-fight roster imports).
- **Pre-2000 round/time formats:** 37 "implausible" times (e.g. 18:00) and
  "decision in round 1" rows are legitimate — no-rounds/overtime era. Recommend
  documenting the convention (store as round 1 + total time) rather than fixing.
- **Title flags:** verified clean in the modern sample. All 6 sampled
  "mismatches" were vacant-title bouts Wikipedia doesn't mark with "(c)" (UFC
  232 Jones-Gustafsson 2, UFC 295 ×2, UFC 314, UFC 12, Ultimate Japan) — the DB
  flag was **correct** in every case. 29 interim flags all have
  `is_title_fight=true` ✓. The 59 PPVs with no title fight flagged are mostly
  legitimately title-less cards (UFC 244, 246, 257, etc.) but the pre-2005
  entries deserve a manual pass.
- **Big-man weights:** Emmanuel Yarborough 770 lbs / Teila Tuli 430 / Thomas
  Ramirez 410 — plausible for these specific super-heavyweights, verify if used
  in UI.
- **Time mismatches vs Wikipedia:** 26/497 (5%) differ, typically by seconds —
  source disagreement (ufcstats vs Wikipedia), low value to chase.
- **UFC 330 (2026-08-15)** exists with zero fights — fine if just announced.
- **Phantom window (2026-05-28):** 87 fights created in the window remain; the
  completed ones now all have methods; the null-result subset is covered in H1.

---

## Pro-records scraper re-run + Sherdog spot-check

**Scraper re-run (519 fighters missing pro records):**
- 34 updated · 315 no Sherdog match · 170 skipped by the wrong-profile guard · 0 errors
- Coverage now: **3,970 / 4,455 fighters** have pro records (485 remaining NULL)
- The 170 guard skips are dominated by the H2 contamination — the guard compares
  Sherdog's (correct) record against a stored "UFC record" that is actually a
  career record, so it wrongly rejects valid profiles (e.g. Jose Alday Sherdog
  13-7 vs stored "14-6"). Fixing H2 and re-running should recover most of these.
- The 315 no-matches are fighters Sherdog's fightfinder couldn't resolve by
  strict full-name match (name variants, romanization differences, or genuinely
  absent profiles).

**Spot-check of stored records (25 random fighters with saved sherdog_id, seed 20260612):**
- **25/25 exact match** against the live Sherdog page (wins/losses/draws/NC)
- 0 identity-suspect profiles, 0 fetch failures
- Conclusion: records that *passed* the guard are accurate; the problem is
  coverage (485 missing), not correctness.

---

## Suggested fix order (pending your review)

1. **C1** Re-import missing V-surname fighters and their fights (biggest data hole).
2. **C2** Backfill the three 2022 events (`fix-fight-methods.js --event` can fill
   methods after results are set; results need API-Sports or Wikipedia import).
3. **H1** Delete the 51 phantom cancelled bouts; set the 18 NULL→'upcoming'.
4. **H2** Zero out (or move to `career_*`) the UFC-record fields for zero-fight
   fighters, then re-run the pro-records scraper — the guard will stop
   false-skipping.
5. **M4** Merge the 3 split/empty duplicate rows.
6. **M1/M2** Normalize method values (draws + Submission/Decision/TKO + the 8
   name-in-method rows).
7. **M3** Fix the 11 winner-slot convention violations; re-run
   `fix-bout-order.js --force` after C1.
8. Re-run `node src/validate.js` + `node src/audit-db.js` to confirm.
