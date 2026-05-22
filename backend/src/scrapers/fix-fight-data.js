/**
 * Re-scrape method, round, time for all existing fights.
 * Fixes the wrong cell indices from the original events scraper.
 * Correct: cells[7]=Method, cells[8]=Round, cells[9]=Time
 *
 * Usage: node src/scrapers/fix-fight-data.js
 */
require('dotenv').config();
const axios    = require('axios');
const cheerio  = require('cheerio');
const supabase = require('../db/client');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1200');
const BASE  = 'http://ufcstats.com';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function scrapeEventFights(eventUfcId) {
  const url = `${BASE}/event-details/${eventUfcId}`;
  try {
    const { data } = await http.get(url);
    const $ = cheerio.load(data);
    const fights = [];
    $('table.b-fight-details__table tbody tr').each((_,row) => {
      const cells = $(row).find('td');
      const f1link = $(cells[1]).find('a').eq(0).attr('href');
      const f2link = $(cells[1]).find('a').eq(1).attr('href');
      if (!f1link || !f2link) return;

      fights.push({
        f1_ufc_id:  f1link.split('/').pop(),
        f2_ufc_id:  f2link.split('/').pop(),
        method:     $(cells[7]).find('p').eq(0).text().trim(),
        method_det: $(cells[7]).find('p').eq(1).text().trim(),
        round:      parseInt($(cells[8]).find('p').eq(0).text().trim() || $(cells[8]).text().trim()) || null,
        time:       $(cells[9]).find('p').eq(0).text().trim() || $(cells[9]).text().trim(),
        f1Str:      $(cells[3]).find('p').eq(0).text().trim() || null,
        f2Str:      $(cells[3]).find('p').eq(1).text().trim() || null,
        f1TD:       $(cells[4]).find('p').eq(0).text().trim() || null,
        f2TD:       $(cells[4]).find('p').eq(1).text().trim() || null,
      });
    });
    return fights;
  } catch { return null; }
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  UFCDB — Fix Fight Method/Round/Time ║');
  console.log('╚══════════════════════════════════════╝\n');

  // Build fighter map: ufc_id → DB id
  const fighterMap = {};
  let fPage = 0;
  while (true) {
    const { data: batch } = await supabase.from('fighters').select('id,ufc_id').not('ufc_id','is',null).range(fPage*1000,(fPage+1)*1000-1);
    if (!batch?.length) break;
    batch.forEach(f => { fighterMap[f.ufc_id] = f.id; });
    if (batch.length < 1000) break;
    fPage++;
  }
  console.log(`${Object.keys(fighterMap).length} fighters mapped`);

  // Get all events with their ufc_id
  const { data: events } = await supabase.from('events').select('id, ufc_id, name').not('ufc_id','is',null).order('date', {ascending:false});
  console.log(`${events.length} events to process\n`);

  let updated = 0, failed = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    await sleep(DELAY);
    const scrapedFights = await scrapeEventFights(ev.ufc_id);
    if (!scrapedFights) { failed++; continue; }

    // Get DB fights for this event
    const { data: dbFights } = await supabase
      .from('fights')
      .select('id, fighter1_id, fighter2_id')
      .eq('event_id', ev.id);
    if (!dbFights?.length) continue;

    // Match scraped fights to DB fights by fighter IDs
    for (const sf of scrapedFights) {
      const f1id = fighterMap[sf.f1_ufc_id];
      const f2id = fighterMap[sf.f2_ufc_id];
      if (!f1id || !f2id) continue;

      const dbFight = dbFights.find(f => f.fighter1_id === f1id && f.fighter2_id === f2id);
      if (!dbFight) continue;

      const patch = {};
      if (sf.method)     patch.method        = sf.method;
      if (sf.method_det) patch.method_detail = sf.method_det;
      if (sf.round)      patch.round         = sf.round;
      if (sf.time)       patch.time          = sf.time;
      if (sf.f1Str)      patch.fighter1_sig_str = sf.f1Str;
      if (sf.f2Str)      patch.fighter2_sig_str = sf.f2Str;
      if (sf.f1TD)       patch.fighter1_td   = sf.f1TD;
      if (sf.f2TD)       patch.fighter2_td   = sf.f2TD;

      if (Object.keys(patch).length === 0) continue;

      const { error } = await supabase.from('fights').update(patch).eq('id', dbFight.id);
      if (!error) updated++; else failed++;
    }

    if ((i+1) % 25 === 0 || i < 3)
      console.log(`[${i+1}/${events.length}] Updated: ${updated} fights | Failed: ${failed}`);
  }

  console.log(`\n✓ Done — updated: ${updated}, failed: ${failed}`);
}

main().catch(console.error);
