/**
 * Scrape official UFC rankings from ufc.com/rankings.
 * Populates the rankings table and updates fighter is_champion / rank fields.
 *
 * Run: node src/scrapers/rankings.js
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const supabase = require('../db/client');

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

// ufc.com weight class name → our DB slug
const WC_SLUG_MAP = {
  'Flyweight':                    'flyweight',
  'Bantamweight':                 'bantamweight',
  'Featherweight':                'featherweight',
  'Lightweight':                  'lightweight',
  'Welterweight':                 'welterweight',
  'Middleweight':                 'middleweight',
  'Light Heavyweight':            'light-heavyweight',
  'Heavyweight':                  'heavyweight',
  "Women's Strawweight":          'womens-strawweight',
  "Women's Flyweight":            'womens-flyweight',
  "Women's Bantamweight":         'womens-bantamweight',
  "Women's Featherweight":        'womens-featherweight',
};

function normalizeSlug(ufcSlug) {
  // ufc.com athlete slugs: "alexander-volkanovski" → our slug is the same
  return ufcSlug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function normalizeName(name) {
  return name.trim().toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ');
}

async function scrapeRankings() {
  const { data } = await http.get('https://www.ufc.com/rankings');
  const $ = cheerio.load(data);

  const divisions = [];
  const seen = new Set();

  $('[class*="view-grouping"]').each(function(_, section) {
    const heading = $(section).find('.view-grouping-header, h4').first().text().trim();
    if (!heading || seen.has(heading)) return;
    seen.add(heading);

    // Skip P4P for now
    if (heading.toLowerCase().includes('pound-for-pound')) return;

    const wcSlug = WC_SLUG_MAP[heading];
    if (!wcSlug) return;

    // Champion
    const champLink = $(section).find('[class*="champion"] a').first();
    const champName = champLink.text().trim();
    const champAthleteSlug = champLink.attr('href')?.replace('/athlete/', '') || '';

    // Ranked fighters (1-15 from the table)
    const ranked = [];
    $(section).find('tr').each(function(_, row) {
      const rankTd = $(row).find('.views-field-weight-class-rank').text().trim();
      const rank = parseInt(rankTd);
      if (isNaN(rank) || rank < 1 || rank > 15) return;

      const link = $(row).find('.views-field-title a');
      const name = link.text().trim();
      const athleteSlug = link.attr('href')?.replace('/athlete/', '') || '';
      if (!name) return;

      ranked.push({ rank, name, athleteSlug });
    });

    divisions.push({ heading, wcSlug, champName, champAthleteSlug, ranked });
  });

  return divisions;
}

async function lookupFighter(name, athleteSlug) {
  // 1. Try our DB slug (usually matches ufc.com slug)
  const ufcSlug = normalizeSlug(athleteSlug);
  if (ufcSlug) {
    const { data } = await supabase.from('fighters').select('id, first_name, last_name').eq('slug', ufcSlug).maybeSingle();
    if (data) return data;
  }

  // 2. Try name matching (first + last)
  const parts = normalizeName(name).split(' ');
  if (parts.length >= 2) {
    const first = parts[0];
    const last  = parts.slice(1).join(' ');
    const { data } = await supabase.from('fighters')
      .select('id, first_name, last_name')
      .ilike('first_name', first)
      .ilike('last_name', last)
      .maybeSingle();
    if (data) return data;
  }

  // 3. Fuzzy: last name only (risky, only use if unique)
  if (parts.length >= 1) {
    const last = parts[parts.length - 1];
    const { data } = await supabase.from('fighters')
      .select('id, first_name, last_name')
      .ilike('last_name', last)
      .limit(2);
    if (data?.length === 1) return data[0];
  }

  return null;
}

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  UFCDB — UFC Rankings Scraper         ║');
  console.log('╚═══════════════════════════════════════╝\n');

  // Load weight class IDs
  const { data: wcs } = await supabase.from('weight_classes').select('id, slug');
  const wcIdBySlug = Object.fromEntries((wcs || []).map(w => [w.slug, w.id]));

  const today = new Date().toISOString().split('T')[0];

  console.log('Scraping ufc.com/rankings...');
  const divisions = await scrapeRankings();
  console.log(`Found ${divisions.length} divisions\n`);

  const allRankedFighterIds  = new Set();
  const allChampionFighterIds = new Set();

  for (const div of divisions) {
    const wcId = wcIdBySlug[div.wcSlug];
    if (!wcId) {
      console.warn(`  No weight class found for: ${div.heading} (slug: ${div.wcSlug})`);
      continue;
    }

    console.log(`\n${div.heading}`);

    // Champion
    let champFighter = null;
    if (div.champName) {
      champFighter = await lookupFighter(div.champName, div.champAthleteSlug);
      if (champFighter) {
        allChampionFighterIds.add(champFighter.id);
        console.log(`  C  ${div.champName} → ${champFighter.first_name} ${champFighter.last_name}`);

        // Update fighter as champion
        await supabase.from('fighters').update({
          is_champion: true,
          is_interim_champ: false,
          rank: null,
          primary_weight_class_id: wcId,
        }).eq('id', champFighter.id);

        // Insert into rankings table (rank 0 = champion)
        await supabase.from('rankings').upsert({
          fighter_id:     champFighter.id,
          weight_class_id: wcId,
          rank:           0,
          is_interim:     false,
          recorded_date:  today,
        }, { onConflict: 'fighter_id,weight_class_id,recorded_date' });
      } else {
        console.warn(`  C  ${div.champName} — NOT FOUND in DB`);
      }
    }

    // Ranked fighters
    for (const r of div.ranked) {
      const fighter = await lookupFighter(r.name, r.athleteSlug);
      if (fighter) {
        allRankedFighterIds.add(fighter.id);
        console.log(`  #${r.rank.toString().padStart(2)} ${r.name} → ${fighter.first_name} ${fighter.last_name}`);

        // Update fighter rank
        await supabase.from('fighters').update({
          rank: r.rank,
          is_champion: false,
        }).eq('id', fighter.id);

        // Insert into rankings table
        await supabase.from('rankings').upsert({
          fighter_id:     fighter.id,
          weight_class_id: wcId,
          rank:           r.rank,
          is_interim:     false,
          recorded_date:  today,
        }, { onConflict: 'fighter_id,weight_class_id,recorded_date' });
      } else {
        console.warn(`  #${r.rank} ${r.name} — NOT FOUND in DB`);
      }
    }
  }

  // Clear is_champion for fighters no longer listed as champions
  if (allChampionFighterIds.size > 0) {
    const champIds = [...allChampionFighterIds];
    const { error } = await supabase.from('fighters')
      .update({ is_champion: false })
      .eq('is_champion', true)
      .not('id', 'in', `(${champIds.join(',')})`);
    if (error) console.warn('  Warn clearing old champions:', error.message);
    else console.log(`\nCleared old champions (kept ${champIds.length} current champs)`);
  }

  console.log(`\nDone — ${allChampionFighterIds.size} champions, ${allRankedFighterIds.size} ranked fighters updated`);
}

main().catch(console.error);
