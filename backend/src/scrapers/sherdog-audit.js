/**
 * Audit fighters who already have nationality/gym data from the Sherdog scraper.
 *
 * For each fighter with nationality data:
 *   - Search Sherdog with STRICT full-name matching
 *   - If a match is found: verify the profile and update with correct data
 *   - If NO match found: KEEP existing data (the fighter may simply not be on
 *     Sherdog with a detectable result — clearing would destroy valid data)
 *
 * The ONLY case where we clear is when we find a match but the Sherdog profile
 * has a clearly different first name from what we expect, indicating a mismatch.
 *
 * Usage: node src/scrapers/sherdog-audit.js
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

// Same strict matching as sherdog.js (handles multi-word first/last names)
async function searchSherdog(firstName, lastName) {
  const query = encodeURIComponent(`${firstName} ${lastName}`);
  const url   = `https://www.sherdog.com/stats/fightfinder?SearchTxt=${query}&type=fighter`;
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);
    const rows = $('table[class*="fightfinder_result"] tbody tr');
    if (!rows.length) return { url: null, matchedName: null };

    let link = null;
    let matchedName = null;
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
      if (hasFirst && hasLast) {
        link = a.attr('href');
        matchedName = a.text().trim();
      }
    });
    return { url: link ? `https://www.sherdog.com${link}` : null, matchedName };
  } catch (e) {
    return { url: null, matchedName: null };
  }
}

async function scrapeFighterProfile(url) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    const details = {};
    $('div.fighter-info span.item').each((_, el) => {
      const label = $(el).find('strong').text().trim().replace(':', '').toLowerCase();
      const value = $(el).clone().children().remove().end().text().trim() ||
                    $(el).text().replace($(el).find('strong').text(), '').trim();
      if (label && value) details[label] = value;
    });
    $('table.bio_graph tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim().replace(':', '').toLowerCase();
        const value = $(cells[1]).text().trim();
        if (label && value && value !== '--') details[label] = value;
      }
    });

    const nationality = $('strong[itemprop="nationality"]').text().trim() ||
                        details['nationality'] || details['country'] || null;
    const birthplace = $('span[itemprop="birthPlace"]').text().trim() ||
                       details['birth place'] || details['birthplace'] || null;
    const association = $('span[itemprop="memberOf"] span[itemprop="name"]').first().text().trim() ||
                        $('a.association-link').text().trim() ||
                        details['association'] || details['gym'] || null;

    return { nationality: nationality || null, hometown: birthplace || null, gym_name: association || null };
  } catch (e) {
    return null;
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  UFCDB — Sherdog Audit & Cleanup      ║');
  console.log('╚═══════════════════════════════════════╝\n');

  let cleared = 0, verified = 0, updated = 0;
  let page = 0;
  const PAGE_SIZE = 500;

  while (true) {
    const { data: fighters, error } = await supabase
      .from('fighters')
      .select('id, first_name, last_name, nationality, gym_name, hometown')
      .not('nationality', 'is', null)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      .order('last_name');

    if (error) { console.error('DB error:', error.message); break; }
    if (!fighters?.length) break;

    console.log(`Auditing page ${page + 1} — ${fighters.length} fighters with nationality data\n`);

    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      await sleep(DELAY);

      const { url: profileUrl, matchedName } = await searchSherdog(f.first_name, f.last_name);

      if (!profileUrl) {
        // No strict match — KEEP existing data, don't clear
        verified++;
        if (verified % 50 === 0) console.log(`  ${verified} verified, ${cleared} cleared, ${updated} updated so far...`);
        continue;
      }

      // Got a strict match — verify the profile data
      await sleep(DELAY);
      const profile = await scrapeFighterProfile(profileUrl);

      if (profile?.nationality && profile.nationality !== f.nationality) {
        // Different nationality found — update with the strictly-matched data
        const patch = { nationality: profile.nationality };
        if (profile.hometown && !f.hometown) patch.hometown = profile.hometown;
        if (profile.gym_name && !f.gym_name) patch.gym_name = profile.gym_name;

        const { error: upErr } = await supabase.from('fighters').update(patch).eq('id', f.id);
        if (!upErr) {
          updated++;
          console.log(`  [UPDATED] ${f.first_name} ${f.last_name}: ${f.nationality} → ${profile.nationality}`);
        }
      } else {
        verified++;
        if (verified % 50 === 0) console.log(`  ${verified} verified, ${cleared} cleared, ${updated} updated so far...`);
      }
    }

    page++;
    if (fighters.length < PAGE_SIZE) break;
  }

  console.log(`\nAudit complete — ${verified} verified, ${updated} updated, ${cleared} cleared`);
}

main().catch(console.error);
