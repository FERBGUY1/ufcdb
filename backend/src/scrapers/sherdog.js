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

// â”€â”€ Search Sherdog for a fighter by name â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function searchSherdog(firstName, lastName) {
  const query = encodeURIComponent(`${firstName} ${lastName}`);
  const url   = `https://www.sherdog.com/search/fighter/${query}`;
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    // First result from search table
    const firstRow = $('table.fightfinder_result tbody tr').first();
    if (!firstRow.length) return null;

    const link = firstRow.find('td a').first().attr('href');
    const nameText = firstRow.find('td a').first().text().trim();

    // Basic name match check
    const searchName = `${firstName} ${lastName}`.toLowerCase();
    if (!nameText.toLowerCase().includes(lastName.toLowerCase())) return null;

    return link ? `https://www.sherdog.com${link}` : null;
  } catch (e) {
    return null;
  }
}

// â”€â”€ Scrape a Sherdog fighter profile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function scrapeFighterProfile(url) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    const details = {};

    // Bio fields from the fighter profile table
    $('.fighter-data .fighter-info .bio-holder .bio th, .fighter-data .fighter-info .bio-holder .bio td').each((i, el) => {
      // bio table uses th for labels, td for values in pairs
    });

    // Try the info box approach
    $('div.fighter-info span.item').each((_, el) => {
      const label = $(el).find('strong').text().trim().replace(':', '').toLowerCase();
      const value = $(el).clone().children().remove().end().text().trim() ||
                    $(el).text().replace($(el).find('strong').text(), '').trim();
      if (label && value) details[label] = value;
    });

    // Alternative selectors for different page layouts
    $('table.bio_graph tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim().replace(':', '').toLowerCase();
        const value = $(cells[1]).text().trim();
        if (label && value && value !== '--') details[label] = value;
      }
    });

    // Nationality / association from profile header area
    const nationality = $('strong[itemprop="nationality"]').text().trim() ||
                        details['nationality'] || details['country'] || null;

    const birthplace = $('span[itemprop="birthPlace"]').text().trim() ||
                       details['birth place'] || details['birthplace'] || details['hometown'] || null;

    const association = $('span[itemprop="memberOf"] span[itemprop="name"]').text().trim() ||
                        $('a.association-link').text().trim() ||
                        details['association'] || details['gym'] || null;

    const headCoach = details['head coach'] || details['coach'] || null;

    const weight = $('span.fighter_weight strong').text().trim() || null;
    const height = $('span.fighter_height strong').text().trim() || null;

    // Pro debut
    const fights = [];
    $('table.fight_history tr:not(.table_head)').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 4) return;
      const dateStr = $(cells[2]).text().trim();
      if (dateStr && dateStr !== 'N/A') fights.push(dateStr);
    });
    const proDebutDate = fights.length ? fights[fights.length - 1] : null;

    return {
      nationality:   nationality || null,
      hometown:      birthplace  || null,
      gym_name:      association || null,
      head_coach:    headCoach   || null,
      pro_debut_date: proDebutDate ? (() => {
        try { return new Date(proDebutDate).toISOString().split('T')[0]; } catch { return null; }
      })() : null,
    };
  } catch (e) {
    return null;
  }
}

// â”€â”€ MAIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  console.log('â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
  console.log('â•‘  UFCDB â€” Sherdog Scraper             â•‘');
  console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•\n');

  // Load all fighters that are missing nationality/gym data
  let updated = 0;
  let failed  = 0;
  let page    = 0;
  const PAGE_SIZE = 500;

  while (true) {
    const { data: fighters, error } = await supabase
      .from('fighters')
      .select('id, first_name, last_name, nationality, gym_name')
      .is('nationality', null)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      .order('last_name');

    if (error) { console.error('DB error:', error.message); break; }
    if (!fighters?.length) break;

    console.log(`Processing page ${page + 1} â€” ${fighters.length} fighters missing nationality data\n`);

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
      if (!profile || !Object.values(profile).some(Boolean)) {
        failed++;
        continue;
      }

      // Only update fields that Sherdog has that we're missing
      const patch = {};
      if (profile.nationality  && !f.nationality)  patch.nationality  = profile.nationality;
      if (profile.hometown     && !f.hometown)      patch.hometown     = profile.hometown;
      if (profile.gym_name     && !f.gym_name)      patch.gym_name     = profile.gym_name;
      if (profile.head_coach   && !f.head_coach)    patch.head_coach   = profile.head_coach;
      if (profile.pro_debut_date)                   patch.pro_debut_date = profile.pro_debut_date;

      if (Object.keys(patch).length === 0) { failed++; continue; }

      const { error: upErr } = await supabase
        .from('fighters')
        .update(patch)
        .eq('id', f.id);

      if (upErr) {
        failed++;
      } else {
        updated++;
        if (updated % 25 === 0) {
          console.log(`  Updated ${updated} fighters so far (failed/no-match: ${failed})`);
        }
      }
    }

    page++;
    if (fighters.length < PAGE_SIZE) break;
  }

  console.log('\nâ•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
  console.log('â•‘  Sherdog scrape complete!            â•‘');
  console.log(`â•‘  Updated:      ${String(updated).padEnd(23)}â•‘`);
  console.log(`â•‘  No match:     ${String(failed).padEnd(23)}â•‘`);
  console.log('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
}

main().catch(console.error);

