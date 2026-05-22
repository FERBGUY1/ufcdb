/**
 * Scrapes recent events to find fights with fighters not yet in the DB.
 * For each missing fighter, scrapes their profile. Then inserts the missing fights.
 * Skips fights that already exist (based on event_id + fighter1_id + fighter2_id).
 *
 * Usage: node src/scrapers/fix-missing-fights.js [--days=365]
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const supabase = require('../db/client');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1500');
const BASE  = 'http://ufcstats.com';
const DAYS  = parseInt(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || '730');

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toSlug = name => name.toLowerCase().replace(/[^a-z0-9\s-]/g,'').replace(/\s+/g,'-').replace(/-+/g,'-').trim();

// Minimal fighter scrape - just what we need to insert
async function scrapeFighterBasic(url) {
  try {
    await sleep(DELAY);
    const { data } = await http.get(url);
    const $ = cheerio.load(data);
    const fullName = $('span.b-content__title-highlight').text().trim();
    if (!fullName) return null;
    const nameParts = fullName.split(' ');
    const first_name = nameParts.slice(0, -1).join(' ') || fullName;
    const last_name  = nameParts.slice(-1)[0] || '';
    const ufc_id     = url.split('/').pop();
    const slug       = toSlug(fullName);
    const nickname   = $('p.b-content__Nickname').text().replace(/"/g,'').trim() || null;
    return { ufc_id, first_name, last_name, nickname, slug, status: 'active' };
  } catch { return null; }
}

async function main() {
  const cutoffDate = new Date(Date.now() - DAYS * 24*60*60*1000).toISOString().split('T')[0];
  console.log(`Looking for missing fights in events since ${cutoffDate}\n`);

  // Load fighter ID map
  const fighterMap = {}; // ufc_id -> DB id
  let fPage = 0;
  while (true) {
    const { data: batch } = await supabase.from('fighters').select('id, ufc_id').not('ufc_id','is',null).range(fPage*1000,(fPage+1)*1000-1);
    if (!batch?.length) break;
    batch.forEach(f => { fighterMap[f.ufc_id] = f.id; });
    if (batch.length < 1000) break;
    fPage++;
  }
  console.log(`  ${Object.keys(fighterMap).length} fighters in map`);

  const { data: wcs } = await supabase.from('weight_classes').select('id, name');
  const wcMap = {};
  for (const wc of wcs || []) wcMap[wc.name] = wc.id;

  // Get events since cutoff
  const { data: events } = await supabase
    .from('events')
    .select('id, ufc_id, name, date')
    .gte('date', cutoffDate)
    .not('ufc_id', 'is', null)
    .order('date', { ascending: false });

  if (!events?.length) { console.log('No recent events found'); return; }
  console.log(`Found ${events.length} events to check\n`);

  // Load existing fight pairs per event
  const existingFights = new Set(); // "event_id:f1_id:f2_id"
  const { data: allFights } = await supabase
    .from('fights')
    .select('event_id, fighter1_id, fighter2_id')
    .in('event_id', events.map(e => e.id));
  for (const f of allFights || []) {
    existingFights.add(`${f.event_id}:${f.fighter1_id}:${f.fighter2_id}`);
    existingFights.add(`${f.event_id}:${f.fighter2_id}:${f.fighter1_id}`);
  }

  let newFighters = 0, newFights = 0, eventCount = 0;

  for (const event of events) {
    await sleep(DELAY);
    try {
      const { data: html } = await http.get(`${BASE}/event-details/${event.ufc_id}`);
      const $ = cheerio.load(html);

      const fightRows = [];
      let boutIdx = 0;

      const rows = $('table.b-fight-details__table tbody tr').toArray();
      for (const row of rows) {
        const cells = $(row).find('td');
        const f1link = $(cells[1]).find('a').eq(0).attr('href');
        const f2link = $(cells[1]).find('a').eq(1).attr('href');
        if (!f1link || !f2link) { boutIdx++; continue; }

        const f1UfcId = f1link.split('/').pop();
        const f2UfcId = f2link.split('/').pop();

        // Scrape missing fighters
        for (const [ufcId, link] of [[f1UfcId, f1link], [f2UfcId, f2link]]) {
          if (!fighterMap[ufcId]) {
            const fighter = await scrapeFighterBasic(link);
            if (fighter) {
              const { data: inserted } = await supabase
                .from('fighters')
                .upsert(fighter, { onConflict: 'ufc_id' })
                .select('id')
                .single();
              if (inserted) {
                fighterMap[ufcId] = inserted.id;
                newFighters++;
                console.log(`  + Scraped fighter: ${fighter.first_name} ${fighter.last_name}`);
              }
            }
          }
        }

        const f1id = fighterMap[f1UfcId];
        const f2id = fighterMap[f2UfcId];
        if (!f1id || !f2id) { boutIdx++; continue; }

        // Skip if fight already exists
        const key = `${event.id}:${f1id}:${f2id}`;
        if (existingFights.has(key)) { boutIdx++; continue; }

        const winCell   = $(cells[0]).text().trim().toLowerCase();
        const wc        = $(cells[6]).find('p').eq(0).text().trim() || $(cells[6]).text().trim();
        const method    = $(cells[7]).find('p').eq(0).text().trim();
        const methodDet = $(cells[7]).find('p').eq(1).text().trim();
        const round     = parseInt($(cells[8]).find('p').eq(0).text().trim() || $(cells[8]).text().trim()) || null;
        const time      = $(cells[9]).find('p').eq(0).text().trim() || $(cells[9]).text().trim();
        const isUpcoming = event.date > new Date().toISOString().split('T')[0];

        let result = null;
        if (winCell.includes('win')) result = 'win';
        else if (winCell.includes('draw')) result = 'draw';
        else if (winCell.includes('nc')) result = 'no_contest';
        else if (isUpcoming) result = 'upcoming';

        const isTitleFight = /title/i.test(wc);
        const wcNorm = wc.replace(/^ufc\s+/i,'').replace(/\s+(interim\s+)?title\s+bout$/i,'').replace(/\s+bout$/i,'').trim();

        fightRows.push({
          event_id: event.id, fighter1_id: f1id, fighter2_id: f2id,
          bout_order: boutIdx++, result, method, method_detail: methodDet,
          round, time, is_title_fight: isTitleFight,
          weight_class_id: wcMap[wcNorm] || null,
        });
        existingFights.add(key);
      }

      if (fightRows.length > 0) {
        const { error } = await supabase.from('fights').insert(fightRows);
        if (error) console.error(`  Error inserting fights for ${event.name}:`, error.message);
        else {
          newFights += fightRows.length;
          console.log(`  ${event.name}: +${fightRows.length} fights`);
        }
      }

      eventCount++;
      if (eventCount % 20 === 0) console.log(`\n  [${eventCount}/${events.length}] events processed\n`);
    } catch (e) {
      console.error(`  Error processing ${event.name}:`, e.message);
    }
  }

  console.log(`\nDone — ${newFighters} new fighters, ${newFights} new fights across ${eventCount} events`);
}

main().catch(console.error);
