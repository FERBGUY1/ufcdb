/**
 * Backfill full professional MMA records (pro_wins, pro_losses, pro_draws, pro_nc)
 * from Sherdog fighter profile pages.
 *
 * Matching reuses the strict full-name search from sherdog.js. Fighters with a
 * stored sherdog_id skip the search and go straight to the profile; newly
 * matched profiles save their sherdog_id so future runs (and other Sherdog
 * scrapers) can skip the search too.
 *
 * Requires the pro_* columns — run src/db/migrations/2026-06-10-add-pro-record.sql
 * in the Supabase SQL editor first.
 *
 * Run: node src/scrapers/sherdog-pro-records.js [--dry-run] [--limit N]
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const supabase = require('../db/client');

const DELAY   = parseInt(process.env.SCRAPE_DELAY_MS || '1500');
const DRY_RUN = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const LIMIT   = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : Infinity;

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Strict full-name matching, same rule as sherdog.js: every word of the first
// and last name must appear in the result's name.
function matchRows(rows, firstWords, lastWords) {
  for (const r of rows) {
    const words = r.name.toLowerCase().split(/\s+/);
    if (firstWords.every(w => words.includes(w)) && lastWords.every(w => words.includes(w)))
      return `https://www.sherdog.com${r.href}`;
  }
  return null;
}

// The fightfinder lists ALL surname matches alphabetically by full name, 20 per
// page — "Jon Jones" sits dozens of pages deep among the Joneses. Page 1 covers
// most fighters; otherwise binary-search the page range for the target name.
const MAX_SEARCH_FETCHES = 14;

async function searchSherdog(firstName, lastName) {
  const query      = encodeURIComponent(`${firstName} ${lastName}`);
  const firstWords = firstName.toLowerCase().split(/\s+/);
  const lastWords  = lastName.toLowerCase().split(/\s+/);
  const target     = `${firstName} ${lastName}`.toLowerCase();

  const getPage = async (p) => {
    try {
      const { data } = await http.get(`https://www.sherdog.com/stats/fightfinder?SearchTxt=${query}&type=fighter&page=${p}`);
      const $ = cheerio.load(data);
      const rows = [];
      // first result table is fighters (a second table holds event matches)
      $('table[class*="fightfinder_result"]').first().find('a[href*="/fighter/"]').each((_, a) => {
        rows.push({ name: $(a).text().trim(), href: $(a).attr('href') });
      });
      return rows;
    } catch {
      return [];
    }
  };

  let fetches = 1;
  const page1 = await getPage(1);
  if (!page1.length) return null;
  let hit = matchRows(page1, firstWords, lastWords);
  if (hit) return hit;
  if (page1.length < 20) return null; // single page of results, no match

  let lo = 1;    // last page known to sort before the target
  let hi = null; // first page known to sort after the target (or be empty)

  // Gallop outward (pages 3, 5, 9, 17, 33, 65 …) to bracket the target
  for (let p = 3; hi === null && fetches < MAX_SEARCH_FETCHES; p = 1 + (p - 1) * 2) {
    await sleep(400);
    const rows = await getPage(p);
    fetches++;
    if (!rows.length) { hi = p; break; }
    hit = matchRows(rows, firstWords, lastWords);
    if (hit) return hit;
    if (rows[0].name.toLowerCase() > target) { hi = p; break; }
    lo = p;
  }
  if (hi === null) return null;

  while (hi - lo > 1 && fetches < MAX_SEARCH_FETCHES) {
    const mid = Math.floor((lo + hi) / 2);
    await sleep(400);
    const rows = await getPage(mid);
    fetches++;
    if (!rows.length) { hi = mid; continue; }
    hit = matchRows(rows, firstWords, lastWords);
    if (hit) return hit;
    if (rows[0].name.toLowerCase() > target) hi = mid;
    else lo = mid;
  }
  return null;
}

// Pro record from the profile header:
//   <div class="winsloses-holder">
//     <div class="winloses win"><span>Wins</span><span>24</span></div>
//     <div class="winloses lose"><span>Losses</span><span>6</span></div>
//     <div class="winloses draws"><span>Draws</span><span>1</span></div>   (only if > 0)
//     <div class="winloses nc"><span>N/C</span><span>1</span></div>        (only if > 0)
async function scrapeProRecord(url) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    const grab = (cls) => {
      const t = $(`div.winloses.${cls} span`).eq(1).text().trim();
      const n = parseInt(t, 10);
      return Number.isNaN(n) ? null : n;
    };

    const wins   = grab('win');
    const losses = grab('lose');
    if (wins === null || losses === null) return null; // not a fighter profile / layout changed

    return {
      pro_wins:   wins,
      pro_losses: losses,
      pro_draws:  grab('draws') ?? 0,
      pro_nc:     grab('nc') ?? 0,
    };
  } catch {
    return null;
  }
}

// All fighters not yet scraped (pro_wins is null), paginated past the 1000-row cap
async function fetchTargets() {
  const all = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fighters')
      .select('id, first_name, last_name, sherdog_id, wins, losses, draws, no_contests')
      .is('pro_wins', null)
      .order('last_name')
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`DB error: ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  UFCDB — Sherdog Pro Records          ║');
  console.log('╚═══════════════════════════════════════╝');
  if (DRY_RUN) console.log('DRY RUN — no writes\n');

  // Fail fast if the migration hasn't been run
  const probe = await supabase.from('fighters').select('pro_wins').limit(1);
  if (probe.error) {
    console.error('\nThe pro_* columns are missing. Run this in the Supabase SQL editor first:');
    console.error('  src/db/migrations/2026-06-10-add-pro-record.sql');
    process.exitCode = 1;
    return;
  }

  const targets = await fetchTargets();
  console.log(`${targets.length} fighters without a pro record${LIMIT < Infinity ? ` (limiting to ${LIMIT})` : ''}\n`);

  let updated = 0, noMatch = 0, mismatch = 0, failed = 0;

  for (let i = 0; i < Math.min(targets.length, LIMIT); i++) {
    const f = targets[i];
    const name = `${f.first_name} ${f.last_name}`;

    let profileUrl = f.sherdog_id
      ? `https://www.sherdog.com/fighter/${f.sherdog_id}`
      : null;

    if (!profileUrl) {
      await sleep(DELAY);
      profileUrl = await searchSherdog(f.first_name, f.last_name);
      if (!profileUrl) {
        noMatch++;
        continue;
      }
    }

    await sleep(DELAY);
    const rec = await scrapeProRecord(profileUrl);
    if (!rec) { failed++; continue; }

    // Wrong-profile guard: a fighter's pro record can't be smaller than their
    // UFC record. If it is, the name match hit a different person — skip.
    const proTotal = rec.pro_wins + rec.pro_losses + rec.pro_draws + rec.pro_nc;
    const ufcTotal = (f.wins || 0) + (f.losses || 0) + (f.draws || 0) + (f.no_contests || 0);
    if (proTotal < ufcTotal || rec.pro_wins < (f.wins || 0) || rec.pro_losses < (f.losses || 0)) {
      mismatch++;
      console.log(`  SKIP (record smaller than UFC record — likely wrong profile): ${name} — Sherdog ${rec.pro_wins}-${rec.pro_losses} vs UFC ${f.wins}-${f.losses}  ${profileUrl}`);
      continue;
    }

    const patch = { ...rec };
    const sherdogId = profileUrl.split('/fighter/')[1]?.split(/[/?#]/)[0];
    if (!f.sherdog_id && sherdogId) patch.sherdog_id = sherdogId;

    if (DRY_RUN) {
      updated++;
      console.log(`  [dry] ${name}: ${rec.pro_wins}-${rec.pro_losses}-${rec.pro_draws}${rec.pro_nc ? ` (${rec.pro_nc} NC)` : ''}`);
      continue;
    }

    let { error: upErr } = await supabase.from('fighters').update(patch).eq('id', f.id);
    if (upErr && patch.sherdog_id) {
      // sherdog_id is UNIQUE — two DB fighters matching one profile means a
      // duplicate-fighter situation; still save the record, just without the id.
      delete patch.sherdog_id;
      ({ error: upErr } = await supabase.from('fighters').update(patch).eq('id', f.id));
    }

    if (upErr) {
      failed++;
      console.log(`  ERROR ${name}: ${upErr.message}`);
    } else {
      updated++;
      if (updated % 25 === 0)
        console.log(`  Updated ${updated}/${Math.min(targets.length, LIMIT)} (no match: ${noMatch}, mismatch: ${mismatch}, failed: ${failed})`);
    }
  }

  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║  Pro record scrape complete!          ║');
  console.log(`║  Updated:   ${String(updated).padEnd(26)}║`);
  console.log(`║  No match:  ${String(noMatch).padEnd(26)}║`);
  console.log(`║  Mismatch:  ${String(mismatch).padEnd(26)}║`);
  console.log(`║  Failed:    ${String(failed).padEnd(26)}║`);
  console.log('╚═══════════════════════════════════════╝');
}

if (require.main === module) main().catch(console.error);

module.exports = { searchSherdog, scrapeProRecord };
