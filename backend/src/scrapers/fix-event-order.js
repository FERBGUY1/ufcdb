/**
 * Backfill bout_order for all existing fights.
 * Fetches fights per event in natural DB order (heap = insertion order, which
 * matches ufcstats page order: main event = 0, co-main = 1, etc.) and assigns
 * sequential bout_order values. Only updates fights that have NULL bout_order.
 *
 * Usage: node src/scrapers/fix-event-order.js
 */
require('dotenv').config();
const supabase = require('../db/client');

async function main() {
  console.log('Backfilling bout_order for existing fights...\n');

  // Get all event IDs
  const eventIds = [];
  let ePage = 0;
  while (true) {
    const { data, error } = await supabase
      .from('events')
      .select('id, name')
      .range(ePage * 1000, (ePage + 1) * 1000 - 1)
      .order('date', { ascending: true, nullsFirst: false });
    if (error) { console.error(error.message); break; }
    if (!data?.length) break;
    data.forEach(e => eventIds.push({ id: e.id, name: e.name }));
    if (data.length < 1000) break;
    ePage++;
  }
  console.log(`Found ${eventIds.length} events\n`);

  let eventsFixed = 0;
  let fightsFixed = 0;

  for (const { id: eventId, name } of eventIds) {
    // Fetch fights for this event that have no bout_order, preserving natural
    // heap/insertion order via created_at ASC (all rows in a batch get the
    // same timestamp, but Postgres typically returns them in insertion order
    // when sorted by the same timestamp value)
    const { data: fights, error } = await supabase
      .from('fights')
      .select('id, bout_order')
      .eq('event_id', eventId)
      .is('bout_order', null)
      .order('created_at', { ascending: true });

    if (error) { console.error(`Event ${name}: ${error.message}`); continue; }
    if (!fights?.length) continue;

    // Find the highest existing bout_order in this event so we append after it
    const { data: maxRows } = await supabase
      .from('fights')
      .select('bout_order')
      .eq('event_id', eventId)
      .not('bout_order', 'is', null)
      .order('bout_order', { ascending: false })
      .limit(1);

    const maxBoutOrder = (maxRows && maxRows.length > 0) ? maxRows[0].bout_order : -1;
    const startIdx = maxBoutOrder + 1;

    const updates = fights.map((f, i) => ({ id: f.id, bout_order: startIdx + i }));

    for (const u of updates) {
      const { error: e2 } = await supabase
        .from('fights')
        .update({ bout_order: u.bout_order })
        .eq('id', u.id);
      if (e2) console.error(`  Fight ${u.id}: ${e2.message}`);
      else fightsFixed++;
    }
    eventsFixed++;

    if (eventsFixed % 50 === 0) {
      console.log(`  ${eventsFixed}/${eventIds.length} events — ${fightsFixed} fights updated`);
    }
  }

  console.log(`\nDone — ${eventsFixed} events, ${fightsFixed} fights updated`);
}

main().catch(console.error);
