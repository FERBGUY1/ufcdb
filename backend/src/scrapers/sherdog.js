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

// Search Sherdog for a fighter by name
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
  } catch {
    return null;
  }
}

// Scrape a Sherdog fighter profile
async function scrapeFighterProfile(url) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    // Nationality — microdata itemprop (reliable)
    const nationality = $('[itemprop="nationality"]').text().trim() || null;

    // Gym / Association — microdata itemprop (reliable)
    const association = $('[itemprop="memberOf"] [itemprop="name"]').first().text().trim() ||
                        $('a.association-link').text().trim() || null;

    // Date of birth — [itemprop="birthDate"] is present on modern Sherdog profiles
    const dobRaw = $('[itemprop="birthDate"]').text().trim();
    let date_of_birth = null;
    if (dobRaw && dobRaw !== '--') {
      try { date_of_birth = new Date(dobRaw).toISOString().split('T')[0]; } catch {}
    }

    // Hometown — Sherdog's span.item[0] holds "Nationality City" concatenated.
    // Strip the nationality prefix to extract just the city/location.
    let hometown = null;
    const spanItemText = $('div.fighter-info span.item').first().text().replace(/\s+/g, ' ').trim();
    if (spanItemText && nationality && spanItemText.startsWith(nationality)) {
      hometown = spanItemText.slice(nationality.length).trim() || null;
    } else if (spanItemText && !nationality) {
      hometown = spanItemText || null;
    }

    // Pro debut — last date in the professional fight history table
    const fightDates = [];
    $('section.fight_history table tr:not(.table_head)').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;
      const d = $(cells[2]).text().trim();
      if (d && d !== 'N/A') fightDates.push(d);
    });
    if (!fightDates.length) {
      $('table.fight_history tr:not(.table_head)').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 4) return;
        const d = $(cells[2]).text().trim();
        if (d && d !== 'N/A') fightDates.push(d);
      });
    }
    let pro_debut_date = null;
    if (fightDates.length) {
      try { pro_debut_date = new Date(fightDates[fightDates.length - 1]).toISOString().split('T')[0]; } catch {}
    }

    // Amateur record
    let amateurWins = 0, amateurLosses = 0;
    $('section.fight_history').each((_, section) => {
      if (!$(section).find('h2, h3').text().toLowerCase().includes('amateur')) return;
      $(section).find('table tr:not(.table_head)').each((_, row) => {
        const cells = $(row).find('td');
        if (!cells.length) return;
        const res = $(cells[0]).find('span').first().text().trim().toLowerCase();
        if (res === 'win')       amateurWins++;
        else if (res === 'loss') amateurLosses++;
      });
    });

    return {
      nationality,
      hometown,
      gym_name:       association  || null,
      date_of_birth,
      amateur_wins:   amateurWins  || null,
      amateur_losses: amateurLosses || null,
      pro_debut_date,
    };
  } catch {
    return null;
  }
}

// MAIN
async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  UFCDB — Sherdog Scraper              ║');
  console.log('╚═══════════════════════════════════════╝\n');

  // Target fighters missing nationality OR hometown (or both).
  // Fighters with nationality but no hometown are now backfilled too.
  let updated = 0;
  let failed  = 0;
  let page    = 0;
  const PAGE_SIZE = 500;

  while (true) {
    const { data: fighters, error } = await supabase
      .from('fighters')
      .select('id, first_name, last_name, nationality, gym_name, hometown, date_of_birth, amateur_wins, pro_debut_date')
      .or('nationality.is.null,hometown.is.null')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      .order('last_name');

    if (error) { console.error('DB error:', error.message); break; }
    if (!fighters?.length) break;

    console.log(`Processing page ${page + 1} — ${fighters.length} fighters missing nationality or hometown\n`);

    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      await sleep(DELAY);

      const profileUrl = await searchSherdog(f.first_name, f.last_name);
      if (!profileUrl) {
        failed++;
        if (i % 50 === 0) console.log(`  [${i+1}/${fighters.length}] No match for ${f.first_name} ${f.last_name}`);
        continue;
      }

      await sleep(DELAY);
      const profile = await scrapeFighterProfile(profileUrl);
      if (!profile || !Object.values(profile).some(v => v)) {
        failed++;
        continue;
      }

      // Only write fields that are currently null in the DB
      const patch = {};
      if (profile.nationality    && !f.nationality)    patch.nationality    = profile.nationality;
      if (profile.hometown       && !f.hometown)       patch.hometown       = profile.hometown;
      if (profile.gym_name       && !f.gym_name)       patch.gym_name       = profile.gym_name;
      if (profile.date_of_birth  && !f.date_of_birth)  patch.date_of_birth  = profile.date_of_birth;
      if (profile.amateur_wins   != null && !f.amateur_wins)  patch.amateur_wins   = profile.amateur_wins;
      if (profile.amateur_losses != null)              patch.amateur_losses = profile.amateur_losses;
      if (profile.pro_debut_date && !f.pro_debut_date) patch.pro_debut_date = profile.pro_debut_date;

      if (Object.keys(patch).length === 0) { failed++; continue; }

      const { error: upErr } = await supabase
        .from('fighters')
        .update(patch)
        .eq('id', f.id);

      if (upErr) {
        failed++;
      } else {
        updated++;
        if (updated % 25 === 0)
          console.log(`  Updated ${updated} fighters so far (failed/no-match: ${failed})`);
      }
    }

    page++;
    if (fighters.length < PAGE_SIZE) break;
  }

  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║  Sherdog scrape complete!             ║');
  console.log(`║  Updated:   ${String(updated).padEnd(26)}║`);
  console.log(`║  No match:  ${String(failed).padEnd(26)}║`);
  console.log('╚═══════════════════════════════════════╝');
}

main().catch(console.error);
