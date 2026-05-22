/**
 * Backfills is_title_fight by re-scraping the weight class column from each ufcstats event page.
 * Matches fights by event_id + bout_order (0-indexed from top of fight table).
 * Usage: node src/scrapers/fix-title-fights.js
 */
require('dotenv').config();
const axios   = require('axios');
const cheerio = require('cheerio');
const supabase = require('../db/client');

const DELAY = parseInt(process.env.SCRAPE_DELAY_MS || '1200');
const BASE  = 'http://ufcstats.com';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('Backfilling is_title_fight from ufcstats...\n');

  // Load all events that have fights in DB
  const { data: events } = await supabase
    .from('events')
    .select('id, ufc_id, name')
    .not('ufc_id', 'is', null)
    .eq('is_complete', true)
    .order('date', { ascending: false });

  if (!events?.length) { console.log('No events found'); return; }
  console.log(`Found ${events.length} completed events\n`);

  let totalUpdated = 0;
  let eventCount = 0;

  for (const event of events) {
    await sleep(DELAY);
    try {
      const url = `${BASE}/event-details/${event.ufc_id}`;
      const { data } = await http.get(url);
      const $ = cheerio.load(data);

      // Load fights for this event ordered by bout_order
      const { data: fights } = await supabase
        .from('fights')
        .select('id, bout_order, is_title_fight')
        .eq('event_id', event.id)
        .order('bout_order', { ascending: true });

      if (!fights?.length) continue;

      // Build list of title fight indices from page
      const titleIndices = [];
      let rowIdx = 0;
      $('table.b-fight-details__table tbody tr').each((_, row) => {
        const wc = $($(row).find('td').get(6)).find('p').eq(0).text().trim() || 
                   $($(row).find('td').get(6)).text().trim();
        if (/title/i.test(wc)) titleIndices.push(rowIdx);
        rowIdx++;
      });

      // Update fights that should be title fights
      let eventUpdated = 0;
      for (const idx of titleIndices) {
        const fight = fights.find(f => f.bout_order === idx);
        if (!fight) continue;
        if (fight.is_title_fight) continue; // already correct

        const { error } = await supabase
          .from('fights')
          .update({ is_title_fight: true })
          .eq('id', fight.id);

        if (!error) { totalUpdated++; eventUpdated++; }
      }

      eventCount++;
      if (eventCount % 50 === 0) {
        console.log(`  ${eventCount}/${events.length} events — ${totalUpdated} fights marked as title fights`);
      }
    } catch (e) {
      // skip this event
    }
  }

  console.log(`\nDone — ${eventCount} events, ${totalUpdated} fights updated`);
}

main().catch(console.error);
