/**
 * Backfill amateur records (amateur_wins, amateur_losses) for fighters.
 * Scrapes Sherdog "FIGHT HISTORY - AMATEUR" section.
 * Run: node src/scrapers/sherdog-amateur.js
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const supabase = require('../db/client');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function searchSherdog(firstName, lastName) {
  const query = encodeURIComponent(`${firstName} ${lastName}`);
  const url   = `https://www.sherdog.com/stats/fightfinder?SearchTxt=${query}&type=fighter`;
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    const first = firstName.toLowerCase();
    const last  = lastName.toLowerCase();
    const firstWords = first.split(/\s+/);
    const lastWords  = last.split(/\s+/);

    let link = null;
    $('a[href*="/fighter/"]').each(function(_, a) {
      if (link) return;
      const nameText = $(a).text().trim().toLowerCase();
      const words = nameText.split(/\s+/);
      const hasFirst = firstWords.every(fw => words.includes(fw));
      const hasLast  = lastWords.every(lw => words.includes(lw));
      if (hasFirst && hasLast) link = $(a).attr('href');
    });
    return link ? `https://www.sherdog.com${link}` : null;
  } catch {
    return null;
  }
}

async function scrapeAmateurRecord(url) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    let amateurWins = 0;
    let amateurLosses = 0;

    // Sherdog HTML structure:
    //   <section>
    //     <div class="tiled_bg latest_features">
    //       <div class="slanted_title"><div>FIGHT HISTORY - AMATEUR</div></div>
    //     </div>
    //     <div class="module fight_history">
    //       <table class="new_table fighter"> ... </table>
    //     </div>
    //   </section>
    $('div.slanted_title').each(function(_, titleDiv) {
      const titleText = $(titleDiv).text().toLowerCase();
      if (!titleText.includes('amateur')) return;

      // Go up: slanted_title -> tiled_bg -> section, then find sibling fight_history
      const section = $(titleDiv).closest('section');
      const tbl = section.find('div.module.fight_history table.new_table.fighter').first();

      tbl.find('tr:not(.table_head)').each(function(_, row) {
        const cells = $(row).find('td');
        if (!cells.length) return;
        const res = $(cells[0]).text().trim().toLowerCase();
        if (res === 'win')       amateurWins++;
        else if (res === 'loss') amateurLosses++;
      });
    });

    return { amateurWins, amateurLosses };
  } catch {
    return null;
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  UFCDB — Sherdog Amateur Records      ║');
  console.log('╚═══════════════════════════════════════╝\n');

  let updated = 0, skipped = 0, failed = 0;
  let page = 0;
  const PAGE_SIZE = 500;

  while (true) {
    const { data: fighters, error } = await supabase
      .from('fighters')
      .select('id, first_name, last_name, amateur_wins, amateur_losses')
      .or('amateur_wins.is.null,amateur_wins.eq.0')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      .order('last_name');

    if (error) { console.error('DB error:', error.message); break; }
    if (!fighters?.length) break;

    console.log(`Page ${page + 1}: ${fighters.length} fighters to check\n`);

    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      await sleep(DELAY);

      const profileUrl = await searchSherdog(f.first_name, f.last_name);
      if (!profileUrl) { failed++; continue; }

      await sleep(DELAY);
      const record = await scrapeAmateurRecord(profileUrl);
      if (!record) { failed++; continue; }

      if (record.amateurWins === 0 && record.amateurLosses === 0) {
        skipped++;
        continue;
      }

      const { error: upErr } = await supabase
        .from('fighters')
        .update({ amateur_wins: record.amateurWins, amateur_losses: record.amateurLosses })
        .eq('id', f.id);

      if (upErr) { failed++; }
      else {
        updated++;
        console.log(`  [${updated}] ${f.first_name} ${f.last_name}: ${record.amateurWins}W-${record.amateurLosses}L amateur`);
      }
    }

    page++;
    if (fighters.length < PAGE_SIZE) break;
  }

  console.log(`\nDone — ${updated} records added, ${skipped} no amateur data, ${failed} failed`);
}

main().catch(console.error);
