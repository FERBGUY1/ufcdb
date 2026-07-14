# Sherdog `sherdog_id` — manual-resolution backlog

Fighters whose professional record (`pro_wins/pro_losses/pro_draws/pro_nc`) could
**not** be filled automatically by `src/scrapers/sherdog-pro-records.js` and need a
manually-supplied `sherdog_id`. Once `sherdog_id` is set, re-running that scraper
(or driving its exported `scrapeProRecord`) fills the record directly, skipping the
name search.

## Background — the ~66 cohort

The 2026-06-23 item-6 Sherdog re-run (see `DATA-AUDIT-2026-06-12.md` §"Pro-records
scraper re-run" and the `project-data-audit` memory) left **384 fighters with
`pro_wins IS NULL`**, split into:

- **~66 wrong-profile mismatches** — a real fighter whose strict full-name search
  collides with a *different* Sherdog person, so the record-size guard
  (`sherdog-pro-records.js:204-210`, SKIP when scraped record < UFC record)
  correctly refuses the overwrite. Only fixable by supplying the correct
  `sherdog_id` per fighter.
- **~318 genuine no-matches** — no findable Sherdog profile under strict
  full-name matching (romanization/name-variant/absent profile).

That ~66 was reported as a **count**, not enumerated. To regenerate the current
list of guard-tripped candidates, run `sherdog-pro-records.js --dry-run` (or the
scoped driver) and collect the rows it logs as
`SKIP (record smaller than UFC record — likely wrong profile)`.

## Open entries

_(none currently — the two below were resolved 2026-07-14)_

## Resolved entries

| Fighter | fighter id | Manual `sherdog_id` | Pro record filled | Why the auto-scraper missed it |
|---|---|---|---|---|
| Benoit Saint Denis | `2533de98-e013-4968-81d5-1209600ff860` | `Benoit-St-Denis-317103` ("God of War") | 17-4-0 (1 NC) | Sherdog abbreviates the surname as **"St. Denis"**, so a `Saint Denis` search never matched (not the accent, as first assumed — accented/plain queries both returned 0 rows). |
| Zach Reese | `82952deb-ae66-465f-bef8-a10ced122359` | `Zachary-Reese-100903` ("Savage", MW) | 10-4-0 (1 NC) | Listed under **"Zachary Reese"**; a `Zach Reese` search resolves first to a 0-1 lightweight namesake (`Zach-Reese-263285`) that trips the record-size guard. |

Both were surfaced by the 2026-07-14 UFC 329 post-event pro-record refresh (all 26
matched fighters updated cleanly +1; these two were the only holdbacks). Resolved
the same day by finding the correct profiles via a broad single-token fightfinder
scan, verifying identity by nickname + weight class, and confirming each scraped
record passes the guard before writing `sherdog_id` + `pro_*`. Future
`sherdog-pro-records.js` runs now hit their profiles directly via the stored id.
