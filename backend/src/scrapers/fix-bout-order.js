/**
 * Fix bout_order for events where the main event fight was assigned a high bout_order
 * because the fighters weren't in the DB when the event was first scraped (or were
 * manually inserted later).
 *
 * Strategy:
 *   1. Parse the event name to extract headliner last names (e.g. "Jones vs. Gane")
 *   2. Find the fight matching those fighters in the event
 *   3. Swap that fight's bout_order with the fight currently at bout_order=0
 *
 * This ensures the main event is always sorted first on event pages.
 *
 * Usage: node src/scrapers/fix-bout-order.js
 */
require('dotenv').config();
const supabase = require('../db/client');

function parseHeadliners(eventName) {
  // Matches ": Name1 vs. Name2" or ": Name1 vs Name2" at the end of the event name
  const m = eventName.match(/:\s*(.+?)\s+vs\.?\s+(.+)$/i);
  if (!m) return null;
  // Take just the LAST word of each name as the last name for matching
  // e.g. "Jon Jones" → "Jones", "Ciryl Gane" → "Gane"
  const last1 = m[1].trim().split(/\s+/).pop().toLowerCase();
  const last2 = m[2].trim().split(/\s+/).pop().toLowerCase();
  return [last1, last2];
}

function fightMatchesHeadliners(fight, last1, last2) {
  const f1 = (fight.fighter1?.last_name || '').toLowerCase();
  const f2 = (fight.fighter2?.last_name || '').toLowerCase();
  return (
    (f1.includes(last1) && f2.includes(last2)) ||
    (f1.includes(last2) && f2.includes(last1))
  );
}

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  UFCDB — Fix Bout Order               ║');
  console.log('╚═══════════════════════════════════════╝\n');

  let fixed = 0, skipped = 0, noMatch = 0;
  let page = 0;
  const PAGE_SIZE = 200;

  while (true) {
    const { data: events, error } = await supabase
      .from('events')
      .select('id, name')
      .eq('is_complete', true)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      .order('date', { ascending: false });

    if (error) { console.error('DB error:', error.message); break; }
    if (!events?.length) break;

    for (const event of events) {
      const headliners = parseHeadliners(event.name);
      if (!headliners) { skipped++; continue; }
      const [last1, last2] = headliners;

      const { data: fights } = await supabase
        .from('fights')
        .select(`
          id, bout_order,
          fighter1:fighters!fighter1_id ( last_name ),
          fighter2:fighters!fighter2_id ( last_name )
        `)
        .eq('event_id', event.id)
        .order('bout_order', { ascending: true });

      if (!fights?.length) { skipped++; continue; }

      const mainFight = fights.find(f => fightMatchesHeadliners(f, last1, last2));
      if (!mainFight) { noMatch++; continue; }

      // Already at position 0 — nothing to do
      if (mainFight.bout_order === 0) { skipped++; continue; }

      // Swap with the fight currently at bout_order=0
      const currentFirst = fights.find(f => f.bout_order === 0);
      const tempOrder = mainFight.bout_order;

      if (currentFirst) {
        await supabase.from('fights').update({ bout_order: tempOrder }).eq('id', currentFirst.id);
      }
      await supabase.from('fights').update({ bout_order: 0 }).eq('id', mainFight.id);

      fixed++;
      console.log(`  Fixed: ${event.name}`);
      console.log(`    ${mainFight.fighter1?.last_name} vs ${mainFight.fighter2?.last_name}: bout_order ${tempOrder} → 0`);
      if (currentFirst) {
        console.log(`    ${currentFirst.fighter1?.last_name} vs ${currentFirst.fighter2?.last_name}: bout_order 0 → ${tempOrder}`);
      }
    }

    page++;
    if (events.length < PAGE_SIZE) break;
  }

  console.log(`\nDone — ${fixed} events fixed, ${skipped} already correct/no pattern, ${noMatch} no matching fight found`);
}

main().catch(console.error);
