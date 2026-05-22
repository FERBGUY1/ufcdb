/**
 * Fix events that have is_complete = false but should be complete:
 *   - Events with a date in the past
 *   - Events with no date but that have non-upcoming fight results
 *
 * Run this if early events (e.g. UFC 1) are missing from the past-events view.
 * Usage: node src/scrapers/fix-events-complete.js
 */
require('dotenv').config();
const supabase = require('../db/client');

async function main() {
  const today = new Date().toISOString().split('T')[0];

  // 1. Events with a past date but is_complete = false
  const { data: pastDateEvents, error: e1 } = await supabase
    .from('events')
    .select('id, name, date')
    .eq('is_complete', false)
    .not('date', 'is', null)
    .lt('date', today);

  if (e1) { console.error('Query error:', e1.message); } else {
    console.log(`Found ${pastDateEvents?.length || 0} past-dated events marked incomplete`);
    if (pastDateEvents?.length) {
      const ids = pastDateEvents.map(e => e.id);
      const { error: u1 } = await supabase.from('events').update({ is_complete: true }).in('id', ids);
      if (u1) console.error('Update error:', u1.message);
      else console.log(`  Fixed ${ids.length} events`);
    }
  }

  // 2. Events with null date — check if they have any completed fights
  const { data: nullDateEvents, error: e2 } = await supabase
    .from('events')
    .select('id, name')
    .eq('is_complete', false)
    .is('date', null);

  if (e2) { console.error('Query error:', e2.message); } else {
    console.log(`\nFound ${nullDateEvents?.length || 0} null-date events marked incomplete`);
    let fixed = 0;
    for (const ev of nullDateEvents || []) {
      const { count } = await supabase
        .from('fights')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', ev.id)
        .not('result', 'eq', 'upcoming')
        .not('result', 'is', null);

      if (count > 0) {
        const { error: u2 } = await supabase
          .from('events')
          .update({ is_complete: true })
          .eq('id', ev.id);
        if (!u2) { fixed++; console.log(`  Fixed: ${ev.name}`); }
      }
    }
    console.log(`  Fixed ${fixed} null-date events`);
  }

  console.log('\nDone.');
}

main().catch(console.error);
