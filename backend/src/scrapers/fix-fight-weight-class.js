/**
 * Backfill weight_class_id for fights where it is null.
 *
 * Root cause: the events scraper stored weight class names from ufcstats as
 * "Lightweight Bout" etc., but the wcMap lookup used exact DB names like
 * "Lightweight", so every lookup returned undefined → null.
 *
 * This script re-scrapes each event page from ufcstats, strips the " Bout"
 * suffix from the raw weight class string, maps to weight_class_id, then
 * patches only the fights still missing that value.
 *
 * Usage: node src/scrapers/fix-fight-weight-class.js
 *        node src/scrapers/fix-fight-weight-class.js --event <ufc_id>
 */
require('dotenv').config();
const axios    = require('axios');
const cheerio  = require('cheerio');
const supabase = require('../db/client');

const BASE  = 'http://ufcstats.com';
const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1200');

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  // Build weight-class lookup: "Lightweight" → id, "Lightweight Bout" → id
  const { data: wcs } = await supabase.from('weight_classes').select('id, name');
  const wcMap = {};
  for (const wc of wcs || []) {
    wcMap[wc.name] = wc.id;
    wcMap[wc.name + ' Bout'] = wc.id;
  }

  // Build fighter lookup: ufc_id → db id
  const fighterMap = {};
  let page = 0;
  while (true) {
    const { data: batch } = await supabase
      .from('fighters')
      .select('id, ufc_id')
      .not('ufc_id', 'is', null)
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!batch?.length) break;
    batch.forEach(f => { fighterMap[f.ufc_id] = f.id; });
    if (batch.length < 1000) break;
    page++;
  }
  console.log(`Mapped ${Object.keys(fighterMap).length} fighters`);

  // Get events to process
  const singleIdx = process.argv.indexOf('--event');
  const singleId  = singleIdx >= 0 ? process.argv[singleIdx + 1] : null;

  let events;
  if (singleId) {
    const { data } = await supabase.from('events').select('id, name, ufc_id').eq('ufc_id', singleId);
    events = data || [];
  } else {
    // Fetch all events that have at least one fight with null weight_class_id
    const { data: nullFightEvents } = await supabase
      .from('fights')
      .select('event_id')
      .is('weight_class_id', null);
    const eventIds = [...new Set((nullFightEvents || []).map(f => f.event_id))];
    if (!eventIds.length) { console.log('No fights with null weight_class_id — nothing to do.'); return; }

    const { data } = await supabase
      .from('events')
      .select('id, name, ufc_id')
      .in('id', eventIds)
      .not('ufc_id', 'is', null)
      .order('date', { ascending: true });
    events = data || [];
  }

  console.log(`Processing ${events.length} events...\n`);
  let updated = 0;
  let skipped = 0;

  for (const event of events) {
    const url = `${BASE}/event-details/${event.ufc_id}`;
    try {
      const { data: html } = await http.get(url);
      const $ = cheerio.load(html);

      const rows = [];
      $('table.b-fight-details__table tbody tr').each((i, row) => {
        const cells  = $(row).find('td');
        const f1link = $(cells[1]).find('a').eq(0).attr('href');
        const f2link = $(cells[1]).find('a').eq(1).attr('href');
        if (!f1link || !f2link) return;

        const wcRaw = $(cells[6]).find('p').eq(0).text().trim() || $(cells[6]).text().trim();
        const wc    = wcRaw.replace(/\s+Bout$/i, '').trim();
        rows.push({
          f1UfcId: f1link.split('/').pop(),
          f2UfcId: f2link.split('/').pop(),
          wcName:  wc,
        });
      });

      for (const row of rows) {
        const wcId = wcMap[row.wcName];
        if (!wcId) { skipped++; continue; }

        const f1Id = fighterMap[row.f1UfcId];
        const f2Id = fighterMap[row.f2UfcId];
        if (!f1Id || !f2Id) { skipped++; continue; }

        // Match by both orderings since fighter1/fighter2 assignment can vary
        const { data: fight } = await supabase
          .from('fights')
          .select('id, weight_class_id')
          .eq('event_id', event.id)
          .or(`and(fighter1_id.eq.${f1Id},fighter2_id.eq.${f2Id}),and(fighter1_id.eq.${f2Id},fighter2_id.eq.${f1Id})`)
          .single();

        if (!fight) { skipped++; continue; }
        if (fight.weight_class_id !== null) { skipped++; continue; }

        const { error } = await supabase
          .from('fights')
          .update({ weight_class_id: wcId })
          .eq('id', fight.id);

        if (error) {
          console.error(`  ✗ ${event.name} — update error: ${error.message}`);
        } else {
          updated++;
        }
      }

      console.log(`  ✓ ${event.name} — ${rows.length} fights processed`);
    } catch (err) {
      console.error(`  ✗ ${event.name} (${event.ufc_id}): ${err.message}`);
    }
    await sleep(DELAY);
  }

  console.log(`\nDone. ${updated} fights updated, ${skipped} skipped.`);
}

main().catch(console.error);
