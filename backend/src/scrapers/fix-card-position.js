require('dotenv').config();
const supabase = require('../db/client');

function derivePositions(sortedFights) {
  const n = sortedFights.length;
  if (n <= 5) {
    return { main_card: sortedFights.map(f => f.id), prelim: [], early_prelim: [] };
  }
  if (n <= 10) {
    return {
      main_card:    sortedFights.slice(0, 5).map(f => f.id),
      prelim:       sortedFights.slice(5).map(f => f.id),
      early_prelim: [],
    };
  }
  if (n <= 14) {
    const earlyCount = n - 9;
    return {
      main_card:    sortedFights.slice(0, 5).map(f => f.id),
      prelim:       sortedFights.slice(5, n - earlyCount).map(f => f.id),
      early_prelim: sortedFights.slice(n - earlyCount).map(f => f.id),
    };
  }
  return {
    main_card:    sortedFights.slice(0, 5).map(f => f.id),
    prelim:       sortedFights.slice(5, 11).map(f => f.id),
    early_prelim: sortedFights.slice(11).map(f => f.id),
  };
}

async function main() {
  console.log('Backfill card_position starting...\n');

  let updatedFights = 0, processedEvents = 0, failedUpdates = 0;
  let page = 0;
  const PAGE_SIZE = 100;

  while (true) {
    const { data: events, error } = await supabase
      .from('events')
      .select('id, name')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
      .order('date', { ascending: true });

    if (error) { console.error('DB error:', error.message); break; }
    if (!events?.length) break;

    for (const event of events) {
      const { data: fights } = await supabase
        .from('fights')
        .select('id, bout_order, card_position')
        .eq('event_id', event.id)
        .order('bout_order', { ascending: true, nullsFirst: false });

      if (!fights?.length) continue;

      const sorted = [...fights].sort((a, b) => (a.bout_order ?? 999) - (b.bout_order ?? 999));
      const { main_card, prelim, early_prelim } = derivePositions(sorted);

      // Only update fights that currently lack card_position; preserve ufcstats-assigned values
      const nullIds = new Set(fights.filter(f => f.card_position == null).map(f => f.id));
      const toMain   = main_card.filter(id => nullIds.has(id));
      const toPrelim = prelim.filter(id => nullIds.has(id));
      const toEarly  = early_prelim.filter(id => nullIds.has(id));

      if (!toMain.length && !toPrelim.length && !toEarly.length) continue;

      const updateJobs = [
        toMain.length   ? supabase.from('fights').update({ card_position: 'main_card'    }).in('id', toMain)   : null,
        toPrelim.length ? supabase.from('fights').update({ card_position: 'prelim'       }).in('id', toPrelim) : null,
        toEarly.length  ? supabase.from('fights').update({ card_position: 'early_prelim' }).in('id', toEarly)  : null,
      ].filter(Boolean);

      const results = await Promise.all(updateJobs);
      const anyFailed = results.some(r => r.error);
      if (anyFailed) {
        failedUpdates++;
        console.error('  FAILED:', event.name);
        results.forEach(r => r.error && console.error('  ', r.error.message));
      } else {
        updatedFights += fights.length;
      }
      processedEvents++;
    }

    page++;
    console.log('Page ' + page + ' done — ' + processedEvents + ' events, ' + updatedFights + ' fights updated');
    if (events.length < PAGE_SIZE) break;
  }

  console.log('\nDone — ' + processedEvents + ' events, ' + updatedFights + ' fights updated, ' + failedUpdates + ' failed');
}

main().catch(console.error);
