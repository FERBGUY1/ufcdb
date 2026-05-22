/**
 * Backfill amateur records (amateur_wins, amateur_losses) for fighters who
 * already have nationality set (meaning Sherdog has their profile).
 * Re-searches Sherdog with strict matching and extracts amateur fight counts.
 *
 * Run AFTER sherdog.js has populated nationality data.
 * Usage: node src/scrapers/sherdog-amateur.js
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
    const rows = $('table[class*="fightfinder_result"] tbody tr');
    if (!rows.length) return null;

    let link = null;
    rows.each((_, row) => {
      if (link) return;
      const a = $(row).find('a[href*="/fighter/"]').first();
      const nameText = a.text().trim().toLowerCase();
      const first = firstName.toLowerCase();
      const last  = lastName.toLowerCase();
      const words      = nameText.split(/\s+/);
      const firstWords = first.split(/\s+/);
      const lastWords  = last.split(/\s+/);
      const hasFirst = firstWords.every(fw => words.includes(fw));
      const hasLast  = lastWords.every(lw => words.includes(lw));
      if (hasFirst && hasLast) link = a.attr('href');
    });
    return link ? `https://www.sherdog.com${link}` : null;
  } catch (e) {
    return null;
  }
}

async function scrapeAmateurRecord(url) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    let amateurWins = 0;
    let amateurLosses = 0;

    $('section.fight_history').each((_, section) => {
      const heading = $(section).find('h2, h3').text().toLowerCase();
      if (!heading.includes('amateur')) return;
      $(section).find('table tr:not(.table_head)').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 2) return;
        const res = $(cells[0]).find('span').first().text().trim().toLowerCase();
        if (res === 'win')       amateurWins++;
        else if (res === 'loss') amateurLosses++;
      });
    });

    return { amateurWins, amateurLosses };
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  UFCDB — Sherdog Amateur Records      ║');
  console.log('╚═══════════════════════════════════════╝\n');

  let updated = 0, failed = 0;
  let page = 0;
  const PAGE_SIZE = 500;

  while (true) {
    const { data: fighters, error } = await supabase
      .from('fighters')
      .select('id, first_name, last_name, amateur_wins, amateur_losses')
      .not('nationality', 'is', null)
      .or('amateur_wins.is.null,amateur_wins.eq.0')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      .order('last_name');

    if (error) { console.error('DB error:', error.message); break; }
    if (!fighters?.length) break;

    console.log(`Processing page ${page + 1} — ${fighters.length} fighters with nationality but no amateur record\n`);

    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      await sleep(DELAY);

      const profileUrl = await searchSherdog(f.first_name, f.last_name);
      if (!profileUrl) { failed++; continue; }

      await sleep(DELAY);
      const record = await scrapeAmateurRecord(profileUrl);
      if (!record) { failed++; continue; }

      if (record.amateurWins === 0 && record.amateurLosses === 0) {
        // No amateur record found — skip to avoid overwriting
        failed++;
        continue;
      }

      const { error: upErr } = await supabase
        .from('fighters')
        .update({ amateur_wins: record.amateurWins, amateur_losses: record.amateurLosses })
        .eq('id', f.id);

      if (upErr) { failed++; }
      else {
        updated++;
        console.log(`  [${i+1}/${fighters.length}] ${f.first_name} ${f.last_name}: ${record.amateurWins}W-${record.amateurLosses}L amateur`);
      }
    }

    page++;
    if (fighters.length < PAGE_SIZE) break;
  }

  console.log(`\nDone — ${updated} amateur records added, ${failed} no data`);
}

main().catch(console.error);
