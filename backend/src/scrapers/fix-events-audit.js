/**
 * Comprehensive event audit — compare every event's DB fight count vs ufcstats.
 * For each event where DB has fewer fights than ufcstats, re-scrape and insert
 * any missing fights (additive only — never deletes existing data).
 *
 * For fighters not yet in DB, attempts to create them from their ufcstats profile.
 *
 * Usage: node src/scrapers/fix-events-audit.js
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const supabase = require('../db/client');
const { randomUUID } = require('crypto');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');
const BASE  = 'http://ufcstats.com';

const http = axios.create({
  timeout: 20000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

// ── Scrape a single fighter profile from ufcstats ─────────────────────────────
async function scrapeFighterProfile(ufcId) {
  try {
    await sleep(DELAY);
    const { data } = await http.get(`${BASE}/fighter-details/${ufcId}`);
    const $ = cheerio.load(data);

    const fullName = $('span.b-content__title-highlight').text().trim();
    if (!fullName) return null;

    const parts = fullName.split(' ');
    const firstName = parts.slice(0, -1).join(' ') || parts[0];
    const lastName  = parts.slice(-1)[0] || '';

    const slug = toSlug(fullName);

    const details = {};
    $('.b-list__info-box dl').each((_, dl) => {
      const dt = $(dl).find('dt').text().trim().replace(':', '').toLowerCase();
      const dd = $(dl).find('dd').text().trim();
      if (dt && dd && dd !== '--') details[dt] = dd;
    });

    const heightStr = details['height'];
    let heightInches = null;
    if (heightStr) {
      const m = heightStr.match(/(\d+)'\s*(\d+)"/);
      if (m) heightInches = parseInt(m[1]) * 12 + parseInt(m[2]);
    }

    const reachStr = details['reach'];
    const reachInches = reachStr ? parseFloat(reachStr) || null : null;

    const weightStr = details['weight'];
    const weightLbs = weightStr ? parseFloat(weightStr) || null : null;

    const stance = details['stance'] || null;
    const dobStr = details['dob'] || details['date of birth'];
    let dob = null;
    if (dobStr && dobStr !== '--') {
      try { dob = new Date(dobStr).toISOString().split('T')[0]; } catch {}
    }

    return { firstName, lastName, slug, ufcId, heightInches, reachInches, weightLbs, stance, dob };
  } catch (e) {
    return null;
  }
}

// ── Fetch all event URLs from ufcstats (mirrors the working events.js approach) ─
async function getAllEventUrls() {
  const urls = [];
  for (const type of ['completed', 'upcoming']) {
    let page = 1;
    while (true) {
      await sleep(DELAY);
      try {
        const { data } = await http.get(`${BASE}/statistics/events/${type}?page=${page}`);
        const $ = cheerio.load(data);
        const links = $('a[href*="/event-details/"]').map((_, a) => $(a).attr('href')).get();
        if (!links.length) break;
        links.forEach(l => { if (!urls.includes(l)) urls.push(l); });
        if (!$('a:contains("Next")').length) break;
        page++;
      } catch { break; }
    }
  }
  return urls;
}

// ── Scrape one event page ─────────────────────────────────────────────────────
async function scrapeEvent(url) {
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);

    const name = $('h2.b-content__title-headline').text().trim();
    if (!name) return null;

    const fights = [];
    $('table.b-fight-details__table tbody tr').each((_, row) => {
      const cells = $(row).find('td');
      const f1link = $(cells[1]).find('a').eq(0).attr('href');
      const f2link = $(cells[1]).find('a').eq(1).attr('href');
      if (!f1link || !f2link) return;

      const winCell   = $(cells[0]).text().trim().toLowerCase();
      const wc        = $(cells[6]).find('p').eq(0).text().trim() || $(cells[6]).text().trim();
      const method    = $(cells[7]).find('p').eq(0).text().trim();
      const methodDet = $(cells[7]).find('p').eq(1).text().trim();
      const round     = parseInt($(cells[8]).find('p').eq(0).text().trim() || $(cells[8]).text().trim()) || null;
      const time      = $(cells[9]).find('p').eq(0).text().trim() || $(cells[9]).text().trim();

      let result = null;
      if (winCell.includes('win'))       result = 'win';
      else if (winCell.includes('draw')) result = 'draw';
      else if (winCell.includes('nc'))   result = 'no_contest';

      const isTitleFight = /title/i.test(wc);
      const wcNorm = wc
        .replace(/^ufc\s+/i, '')
        .replace(/\s+(interim\s+)?title\s+bout$/i, '')
        .replace(/\s+bout$/i, '')
        .trim();

      fights.push({
        fighter1_ufc_id: f1link.split('/').pop(),
        fighter2_ufc_id: f2link.split('/').pop(),
        result, method, method_detail: methodDet, round, time,
        weight_class_name: wcNorm || wc,
        is_title_fight: isTitleFight,
      });
    });

    return { name, ufc_id: url.split('/').pop(), fights };
  } catch (e) {
    return null;
  }
}

// ── Determine weight class ID from name ──────────────────────────────────────
function resolveWcId(wcName, wcMap) {
  if (!wcName) return null;
  if (wcMap[wcName]) return wcMap[wcName];
  // Try partial match
  for (const [k, v] of Object.entries(wcMap)) {
    if (k.toLowerCase().includes(wcName.toLowerCase()) ||
        wcName.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return null;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  UFCDB — Comprehensive Event Audit    ║');
  console.log('╚═══════════════════════════════════════╝\n');

  // Load fighter map
  const fighterMap = {};
  let fPage = 0;
  while (true) {
    const { data: batch } = await supabase.from('fighters').select('id, ufc_id').not('ufc_id', 'is', null).range(fPage * 1000, (fPage + 1) * 1000 - 1);
    if (!batch?.length) break;
    batch.forEach(f => { fighterMap[f.ufc_id] = f.id; });
    if (batch.length < 1000) break;
    fPage++;
  }
  console.log(`  ${Object.keys(fighterMap).length} fighters in map`);

  // Load weight class map
  const { data: wcs } = await supabase.from('weight_classes').select('id, name');
  const wcMap = {};
  for (const wc of wcs || []) wcMap[wc.name] = wc.id;

  // Load existing events map (ufc_id → {id, fight_count})
  const eventMap = {};
  let ePage = 0;
  while (true) {
    const { data: batch } = await supabase.from('events').select('id, ufc_id, name').not('ufc_id', 'is', null).range(ePage * 1000, (ePage + 1) * 1000 - 1);
    if (!batch?.length) break;
    batch.forEach(e => { eventMap[e.ufc_id] = { id: e.id, name: e.name }; });
    if (batch.length < 1000) break;
    ePage++;
  }
  console.log(`  ${Object.keys(eventMap).length} events in DB\n`);

  // Load existing fights per event
  const dbFightsByEvent = {};
  let fightPage = 0;
  while (true) {
    const { data: batch } = await supabase.from('fights').select('event_id, fighter1_id, fighter2_id').range(fightPage * 1000, (fightPage + 1) * 1000 - 1);
    if (!batch?.length) break;
    batch.forEach(f => {
      if (!dbFightsByEvent[f.event_id]) dbFightsByEvent[f.event_id] = new Set();
      dbFightsByEvent[f.event_id].add(`${f.fighter1_id}:${f.fighter2_id}`);
      dbFightsByEvent[f.event_id].add(`${f.fighter2_id}:${f.fighter1_id}`);
    });
    if (batch.length < 1000) break;
    fightPage++;
  }

  // Build event URL list — first try ufcstats, fall back to DB event list
  console.log('Fetching event list from ufcstats...');
  let eventUrls = await getAllEventUrls();
  if (eventUrls.length < 10) {
    console.log('  ufcstats fetch returned few/no URLs — using DB event list as fallback');
    eventUrls = Object.keys(eventMap).map(ufcId => `${BASE}/event-details/${ufcId}`);
  }
  console.log(`Found ${eventUrls.length} events to audit\n`);

  let eventsChecked = 0, eventsFixed = 0, fightsAdded = 0;
  let newFighters = 0;
  const missingFighters = new Set();
  const report = [];

  for (let i = 0; i < eventUrls.length; i++) {
    const url = eventUrls[i];
    const ufcId = url.split('/').pop();
    const dbEvent = eventMap[ufcId];

    if (!dbEvent) {
      // Event not in DB at all — skip for now (full import is separate)
      if (i % 50 === 0) console.log(`  [${i + 1}/${eventUrls.length}] events checked — ${eventsFixed} fixed, ${fightsAdded} fights added`);
      eventsChecked++;
      continue;
    }

    const dbFightSet = dbFightsByEvent[dbEvent.id] || new Set();
    const dbFightCount = dbFightSet.size / 2; // each fight stored in both directions

    await sleep(DELAY);
    const scraped = await scrapeEvent(url);

    if (!scraped) {
      eventsChecked++;
      if (i % 50 === 0) console.log(`  [${i + 1}/${eventUrls.length}] events checked — ${eventsFixed} fixed, ${fightsAdded} fights added`);
      continue;
    }

    eventsChecked++;
    const ufcFightCount = scraped.fights.length;

    if (ufcFightCount <= dbFightCount) {
      if (i % 50 === 0) console.log(`  [${i + 1}/${eventUrls.length}] events checked — ${eventsFixed} fixed, ${fightsAdded} fights added`);
      continue;
    }

    // This event is incomplete — find and insert missing fights
    const missing = [];
    let boutIdx = dbFightCount; // start bout_order after existing fights

    for (const f of scraped.fights) {
      let f1id = fighterMap[f.fighter1_ufc_id];
      let f2id = fighterMap[f.fighter2_ufc_id];

      // Try to add unknown fighters
      if (!f1id) {
        const profile = await scrapeFighterProfile(f.fighter1_ufc_id);
        if (profile) {
          const newId = randomUUID();
          const { error } = await supabase.from('fighters').insert({
            id: newId, ufc_id: f.fighter1_ufc_id,
            first_name: profile.firstName, last_name: profile.lastName,
            slug: profile.slug, status: 'active',
            height_inches: profile.heightInches, reach_inches: profile.reachInches,
            weight_lbs: profile.weightLbs, stance: profile.stance,
            date_of_birth: profile.dob,
          });
          if (!error) { fighterMap[f.fighter1_ufc_id] = newId; f1id = newId; newFighters++; }
        }
        if (!f1id) { missingFighters.add(f.fighter1_ufc_id); }
      }

      if (!f2id) {
        const profile = await scrapeFighterProfile(f.fighter2_ufc_id);
        if (profile) {
          const newId = randomUUID();
          const { error } = await supabase.from('fighters').insert({
            id: newId, ufc_id: f.fighter2_ufc_id,
            first_name: profile.firstName, last_name: profile.lastName,
            slug: profile.slug, status: 'active',
            height_inches: profile.heightInches, reach_inches: profile.reachInches,
            weight_lbs: profile.weightLbs, stance: profile.stance,
            date_of_birth: profile.dob,
          });
          if (!error) { fighterMap[f.fighter2_ufc_id] = newId; f2id = newId; newFighters++; }
        }
        if (!f2id) { missingFighters.add(f.fighter2_ufc_id); }
      }

      if (!f1id || !f2id) continue;

      // Check if fight already in DB
      if (dbFightSet.has(`${f1id}:${f2id}`)) continue;

      missing.push({
        id: randomUUID(),
        event_id: dbEvent.id,
        fighter1_id: f1id,
        fighter2_id: f2id,
        bout_order: boutIdx++,
        result: f.result,
        method: f.method,
        method_detail: f.method_detail || null,
        round: f.round,
        time: f.time || null,
        is_title_fight: f.is_title_fight || false,
        weight_class_id: resolveWcId(f.weight_class_name, wcMap),
      });

      // Update local set to avoid duplicates within this event
      dbFightSet.add(`${f1id}:${f2id}`);
      dbFightSet.add(`${f2id}:${f1id}`);
    }

    if (missing.length > 0) {
      const { error } = await supabase.from('fights').insert(missing);
      if (error && !error.message?.includes('duplicate')) {
        console.error(`  Insert error (${scraped.name}):`, error.message);
      } else {
        fightsAdded += missing.length;
        eventsFixed++;
        report.push(`  + ${scraped.name}: added ${missing.length} fight(s) (had ${dbFightCount}, ufcstats has ${ufcFightCount})`);
        console.log(report[report.length - 1]);
      }
    }

    if (i % 50 === 0) console.log(`  [${i + 1}/${eventUrls.length}] events checked — ${eventsFixed} fixed, ${fightsAdded} fights added`);
  }

  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║  Audit Complete                       ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`  Events checked:  ${eventsChecked}`);
  console.log(`  Events fixed:    ${eventsFixed}`);
  console.log(`  Fights added:    ${fightsAdded}`);
  console.log(`  New fighters:    ${newFighters}`);
  if (missingFighters.size > 0) {
    console.log(`  Still missing:   ${missingFighters.size} fighters (no ufcstats profile found)`);
  }
  if (report.length > 0) {
    console.log('\nFixed events:');
    report.forEach(r => console.log(r));
  }
}

main().catch(console.error);
