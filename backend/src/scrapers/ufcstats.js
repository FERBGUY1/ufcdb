/**
 * UFC Stats Scraper
 * Scrapes ufcstats.com for all historical fighter data and fight records.
 * Run once for initial import, then incrementally after each event.
 *
 * Usage: node src/scrapers/ufcstats.js
 */

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const slugify = require('slugify');

function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
const supabase = require('../db/client');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');
const BASE = 'http://ufcstats.com';

// Concurrency — max 2 simultaneous requests to be respectful
const limit = pLimit(2);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; UFCDBBot/1.0; +https://ufcdb.com/bot)',
  },
});

// ── HELPERS ──────────────────────────────────────────────
function toSlug(name) {
  return slugify(name, { lower: true, strict: true });
}

function parseRecord(record) {
  // Parses "26-1-0" or "26-1-0 (1 NC)"
  if (!record) return { wins: 0, losses: 0, draws: 0, nc: 0 };
  const match = record.match(/(\d+)-(\d+)-(\d+)/);
  const ncMatch = record.match(/\((\d+)\s+NC\)/);
  return {
    wins:   match ? parseInt(match[1]) : 0,
    losses: match ? parseInt(match[2]) : 0,
    draws:  match ? parseInt(match[3]) : 0,
    nc:     ncMatch ? parseInt(ncMatch[1]) : 0,
  };
}

function parseHeightToInches(height) {
  // Parses "6' 4\"" -> 76
  if (!height) return null;
  const match = height.match(/(\d+)'\s*(\d+)"/);
  return match ? parseInt(match[1]) * 12 + parseInt(match[2]) : null;
}

function parseReachToInches(reach) {
  // Parses "84\"" -> 84
  if (!reach) return null;
  const match = reach.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

function parseWeight(weight) {
  if (!weight) return null;
  const match = weight.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

function inferWeightClassId(weight_class_name, weightClassMap) {
  if (!weight_class_name) return null;
  const normalized = weight_class_name.toLowerCase();
  for (const [name, id] of Object.entries(weightClassMap)) {
    if (normalized.includes(name.toLowerCase())) return id;
  }
  return null;
}

// ── STEP 1: Get all fighter URLs from the A-Z fighter list ──
async function getAllFighterUrls() {
  console.log('Fetching fighter list pages...');
  const urls = new Set();

  // UFC Stats has A-Z fighter listing
  const chars = 'abcdefghijklmnopqrstuvwxyz'.split('');

  for (const char of chars) {
    await sleep(DELAY);
    try {
      const url = `${BASE}/statistics/fighters?char=${char}&page=all`;
      const { data } = await http.get(url);
      const $ = cheerio.load(data);

      $('table.b-statistics__table tbody tr').each((_, row) => {
        const link = $(row).find('td a').first().attr('href');
        if (link && link.includes('/fighter-details/')) {
          urls.add(link);
        }
      });

      console.log(`  ${char.toUpperCase()}: found ${urls.size} total fighters so far`);
    } catch (e) {
      console.error(`  Failed to fetch list for char ${char}:`, e.message);
    }
  }

  return Array.from(urls);
}

// ── STEP 2: Scrape individual fighter page ────────────────
async function scrapeFighter(url, weightClassMap) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    // Name
    const fullName = $('span.b-content__title-highlight').text().trim();
    if (!fullName) return null;

    const nameParts = fullName.split(' ');
    const first_name = nameParts.slice(0, -1).join(' ') || fullName;
    const last_name  = nameParts.slice(-1)[0] || '';

    const nickname = $('p.b-content__Nickname').text().replace(/"/g, '').trim() || null;

    // Record
    const recordText = $('p.b-content__title-record').text().replace('Record:', '').trim();
    const { wins, losses, draws, nc } = parseRecord(recordText);

    // Physical stats from the info boxes
    const infoItems = {};
    $('ul.b-list__box-list li.b-list__box-list-item').each((_, el) => {
      const label = $(el).find('i.b-list__box-item-title').text().trim().replace(':', '');
      const value = $(el).text().replace($(el).find('i').text(), '').trim();
      if (label) infoItems[label] = value;
    });

    const height_inches  = parseHeightToInches(infoItems['Height']);
    const reach_inches   = parseReachToInches(infoItems['Reach']);
    const weight_lbs     = parseWeight(infoItems['Weight']);
    const stance         = infoItems['STANCE'] || infoItems['Stance'] || null;
    const dob_str        = infoItems['DOB'];
    const date_of_birth  = dob_str && dob_str !== '--' ? new Date(dob_str).toISOString().split('T')[0] : null;

    // Fight stats
    const statsItems = {};
    $('ul.b-list__box-list-item_type_block').each((_, el) => {
      const label = $(el).find('i').text().trim().replace(':', '');
      const value = $(el).text().replace($(el).find('i').text(), '').trim();
      if (label) statsItems[label] = value;
    });

    const parseStatPct = (val) => {
      if (!val || val === '--') return null;
      const n = parseFloat(val.replace('%', ''));
      return isNaN(n) ? null : n;
    };
    const parseStat = (val) => {
      if (!val || val === '--') return null;
      const n = parseFloat(val);
      return isNaN(n) ? null : n;
    };

    // Determine primary weight class from fight history
    let primary_weight_class_id = null;
    const weightClassCounts = {};
    $('table.b-fight-details__table tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      const wc = $(cells[6]).text().trim();
      if (wc) weightClassCounts[wc] = (weightClassCounts[wc] || 0) + 1;
    });
    const mostCommonWC = Object.entries(weightClassCounts).sort((a,b) => b[1]-a[1])[0];
    if (mostCommonWC) {
      primary_weight_class_id = inferWeightClassId(mostCommonWC[0], weightClassMap);
    }

    // Extract UFC ID from URL
    const ufc_id = url.split('/').pop();

    const fighter = {
      ufc_id,
      first_name,
      last_name,
      nickname,
      slug: toSlug(fullName),
      wins, losses, draws, no_contests: nc,
      height_inches,
      reach_inches,
      weight_lbs,
      stance,
      date_of_birth,
      primary_weight_class_id,
      slpm:    parseStat(statsItems['SLpM']),
      sapm:    parseStat(statsItems['SApM']),
      str_acc: parseStatPct(statsItems['Str. Acc.']),
      str_def: parseStatPct(statsItems['Str. Def']),
      td_avg:  parseStat(statsItems['TD Avg.']),
      td_acc:  parseStatPct(statsItems['TD Acc.']),
      td_def:  parseStatPct(statsItems['TD Def.']),
      sub_avg: parseStat(statsItems['Sub. Avg.']),
      last_synced_at: new Date().toISOString(),
    };

    return fighter;
  } catch (e) {
    console.error(`  Error scraping ${url}:`, e.message);
    return null;
  }
}

// ── STEP 3: Scrape all events and fights ─────────────────
async function scrapeAllEvents() {
  console.log('\nFetching all UFC events...');
  const { data } = await http.get(`${BASE}/statistics/events/completed?page=all`);
  const $ = cheerio.load(data);

  const eventUrls = [];
  $('table.b-statistics__table_events tbody tr td a').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/event-details/')) {
      eventUrls.push(href);
    }
  });

  console.log(`Found ${eventUrls.length} events`);
  return eventUrls;
}

async function scrapeEvent(url) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    // Event details
    const name = $('span.b-content__title-highlight').text().trim();
    const details = {};
    $('ul.b-list__box-list li.b-list__box-list-item').each((_, el) => {
      const label = $(el).find('i').text().trim().replace(':', '');
      const value = $(el).text().replace($(el).find('i').text(), '').trim();
      if (label) details[label] = value;
    });

    const dateStr = details['Date'];
    const location = details['Location'] || '';
    const locationParts = location.split(',').map(s => s.trim());

    const event = {
      ufc_id: url.split('/').pop(),
      name,
      slug: toSlug(name),
      date: dateStr ? new Date(dateStr).toISOString().split('T')[0] : null,
      venue: details['Venue'] || null,
      city: locationParts[0] || null,
      state: locationParts[1] || null,
      country: locationParts[2] || locationParts[1] || null,
      is_complete: true,
    };

    // Fights on this event
    const fights = [];
    $('table.b-fight-details__table tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      const fighter1Link = $(cells[1]).find('a').eq(0).attr('href');
      const fighter2Link = $(cells[1]).find('a').eq(1).attr('href');
      const winnerText  = $(cells[0]).text().trim();
      const method      = $(cells[8]).find('p').eq(0).text().trim();
      const methodDetail = $(cells[8]).find('p').eq(1).text().trim();
      const round       = parseInt($(cells[9]).text().trim()) || null;
      const time        = $(cells[10]).text().trim();
      const timeFormat  = $(cells[11]).text().trim();
      const weightClass = $(cells[6]).text().trim();
      const titleFight  = $(cells[7]).text().trim().toLowerCase().includes('title');

      fights.push({
        fighter1_ufc_id: fighter1Link ? fighter1Link.split('/').pop() : null,
        fighter2_ufc_id: fighter2Link ? fighter2Link.split('/').pop() : null,
        result: winnerText.includes('win') ? 'win' : winnerText.includes('draw') ? 'draw' : winnerText.includes('nc') ? 'no_contest' : null,
        method,
        method_detail: methodDetail,
        round,
        time,
        time_format: timeFormat,
        weight_class_name: weightClass,
        is_title_fight: titleFight,
      });
    });

    return { event, fights };
  } catch (e) {
    console.error(`  Error scraping event ${url}:`, e.message);
    return null;
  }
}

// ── MAIN ORCHESTRATOR ─────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  UFCDB — UFC Stats Scraper           ║');
  console.log('╚══════════════════════════════════════╝\n');

  // Get weight class map from DB
  const { data: weightClasses } = await supabase
    .from('weight_classes')
    .select('id, name');

  const weightClassMap = {};
  if (weightClasses) {
    for (const wc of weightClasses) {
      weightClassMap[wc.name] = wc.id;
    }
  }

  // ── Phase 1: Fighters ──
  console.log('Phase 1: Scraping fighter profiles...\n');
  const fighterUrls = await getAllFighterUrls();
  console.log(`\nTotal fighter URLs: ${fighterUrls.length}`);

  let imported = 0;
  let failed = 0;

  const BATCH_SIZE = 50;
  for (let i = 0; i < fighterUrls.length; i += BATCH_SIZE) {
    const batch = fighterUrls.slice(i, i + BATCH_SIZE);

    const fighters = await Promise.all(
      batch.map(url => limit(async () => {
        await sleep(DELAY);
        return scrapeFighter(url, weightClassMap);
      }))
    );

    const validFighters = fighters.filter(Boolean);

    if (validFighters.length > 0) {
      const { error } = await supabase
        .from('fighters')
        .upsert(validFighters, { onConflict: 'ufc_id', ignoreDuplicates: false });

      if (error) {
        console.error(`Batch upsert error:`, error.message);
        failed += validFighters.length;
      } else {
        imported += validFighters.length;
      }
    }

    const progress = Math.min(i + BATCH_SIZE, fighterUrls.length);
    console.log(`Progress: ${progress}/${fighterUrls.length} (${Math.round(progress/fighterUrls.length*100)}%) — imported: ${imported}, failed: ${failed}`);
  }

  console.log(`\n✓ Fighter import complete: ${imported} imported, ${failed} failed\n`);

  // ── Phase 2: Events & Fights ──
  console.log('Phase 2: Scraping events and fight records...\n');
  const eventUrls = await scrapeAllEvents();

  let eventsImported = 0;
  let fightsImported = 0;

  for (const eventUrl of eventUrls) {
    await sleep(DELAY);
    const result = await scrapeEvent(eventUrl);
    if (!result) continue;

    const { event, fights } = result;

    // Upsert event
    const { data: eventData, error: eventError } = await supabase
      .from('events')
      .upsert(event, { onConflict: 'ufc_id' })
      .select('id')
      .single();

    if (eventError || !eventData) {
      console.error(`  Failed to upsert event ${event.name}:`, eventError?.message);
      continue;
    }

    eventsImported++;

    // Link fights to event
    for (const fight of fights) {
      if (!fight.fighter1_ufc_id || !fight.fighter2_ufc_id) continue;

      // Look up fighter UUIDs
      const { data: f1 } = await supabase
        .from('fighters')
        .select('id')
        .eq('ufc_id', fight.fighter1_ufc_id)
        .single();
      const { data: f2 } = await supabase
        .from('fighters')
        .select('id')
        .eq('ufc_id', fight.fighter2_ufc_id)
        .single();

      if (!f1 || !f2) continue;

      const fightRecord = {
        event_id: eventData.id,
        fighter1_id: f1.id,
        fighter2_id: f2.id,
        method: fight.method,
        method_detail: fight.method_detail,
        round: fight.round,
        time: fight.time,
        time_format: fight.time_format,
        is_title_fight: fight.is_title_fight,
        result: fight.result,
      };

      const { error: fightError } = await supabase
        .from('fights')
        .upsert(fightRecord, { onConflict: 'event_id,fighter1_id,fighter2_id', ignoreDuplicates: true });

      if (!fightError) fightsImported++;
    }

    if (eventsImported % 10 === 0) {
      console.log(`Events: ${eventsImported}/${eventUrls.length} — Fights: ${fightsImported}`);
    }
  }

  console.log(`\n✓ Event import complete: ${eventsImported} events, ${fightsImported} fights\n`);
  console.log('═══════════════════════════════════════');
  console.log('  Scrape complete!');
  console.log(`  Fighters: ${imported}`);
  console.log(`  Events:   ${eventsImported}`);
  console.log(`  Fights:   ${fightsImported}`);
  console.log('═══════════════════════════════════════');
}

main().catch(console.error);
