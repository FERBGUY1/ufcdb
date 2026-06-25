require('dotenv').config();
const supabase = require('../db/client');

async function main() {
  console.log('Recalculating fighter records from fights table...');

  const records = {};
  const init = () => ({ wins: 0, losses: 0, draws: 0, no_contests: 0 });

  let page = 0;
  const PAGE = 1000;
  let total = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('fights')
      .select('fighter1_id, fighter2_id, winner_id, result')
      .neq('result', 'upcoming')
      .not('result', 'is', null)
      .range(page * PAGE, (page + 1) * PAGE - 1);

    if (error) { console.error(error.message); break; }
    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const { fighter1_id: f1, fighter2_id: f2, winner_id, result } = r;
      if (!f1 || !f2) continue;
      if (!records[f1]) records[f1] = init();
      if (!records[f2]) records[f2] = init();

      if (result === 'win') {
        // Use winner_id when set (API-Sports fights may have winner as either fighter1 or fighter2).
        // Fall back to fighter1=winner for legacy ufcstats data (winner always listed first).
        const winnerId = winner_id || f1;
        const loserId  = winnerId === f1 ? f2 : f1;
        if (!records[winnerId]) records[winnerId] = init();
        if (!records[loserId])  records[loserId]  = init();
        records[winnerId].wins++;
        records[loserId].losses++;
      } else if (result === 'draw') {
        records[f1].draws++;
        records[f2].draws++;
      } else if (result === 'no_contest') {
        records[f1].no_contests++;
        records[f2].no_contests++;
      }
    }

    total += rows.length;
    if (rows.length < PAGE) break;
    page++;
  }

  const fighterIds = Object.keys(records);
  console.log(`  Processed ${total} fight rows`);
  console.log(`  Calculated records for ${fighterIds.length} fighters`);

  // Update fighters concurrently in chunks of 50
  const CONCURRENT = 50;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < fighterIds.length; i += CONCURRENT) {
    const chunk = fighterIds.slice(i, i + CONCURRENT);
    await Promise.all(chunk.map(async id => {
      const rec = records[id];
      const { error } = await supabase
        .from('fighters')
        .update({ wins: rec.wins, losses: rec.losses, draws: rec.draws, no_contests: rec.no_contests })
        .eq('id', id);
      if (error) { errors++; }
      else updated++;
    }));

    if ((i + CONCURRENT) % 500 === 0) {
      process.stdout.write(`\r  ${updated}/${fighterIds.length} updated...`);
    }
  }

  console.log(`\nDone -- ${updated} updated, ${errors} errors`);
}

main().catch(console.error);
