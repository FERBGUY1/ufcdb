/**
 * Classify all fighters as 'active' or 'retired' based on their most recent fight date.
 * Active:  last fight on or after 2024-01-01, OR has an upcoming fight
 * Retired: last fight before 2024-01-01 AND no upcoming fights (and has fought at least once)
 * Unknown: no fights in DB at all → leave as 'active' (default)
 *
 * Usage: node src/scrapers/fix-fighter-status.js
 */
require('dotenv').config();
const supabase = require('../db/client');

// Fighters whose last fight was more than 12 months ago (and no upcoming fight)
// are considered retired. Rolling window stays accurate as time passes.
const cutoffDate = new Date();
cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);
const ACTIVE_CUTOFF = cutoffDate.toISOString().split('T')[0];

async function main() {
  console.log('Building fighter → last-fight-date map...');

  // Collect all (fighter_id, event_date, result) rows in pages
  const latestDate = {};   // fighter_id → ISO date string of most recent fight
  const hasUpcoming = new Set();

  let page = 0;
  const PAGE = 1000;
  while (true) {
    const { data: rows, error } = await supabase
      .from('fights')
      .select('fighter1_id, fighter2_id, result, events(date)')
      .range(page * PAGE, (page + 1) * PAGE - 1);

    if (error) { console.error(error.message); break; }
    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const date = r.events?.date;
      const ids  = [r.fighter1_id, r.fighter2_id].filter(Boolean);

      for (const id of ids) {
        if (r.result === 'upcoming') {
          hasUpcoming.add(id);
        } else if (date) {
          if (!latestDate[id] || date > latestDate[id]) latestDate[id] = date;
        }
      }
    }

    if (rows.length < PAGE) break;
    page++;
  }

  console.log(`  Processed ${page * PAGE + Object.keys(latestDate).length} fight rows`);
  console.log(`  Fighters with fight history: ${Object.keys(latestDate).length}`);
  console.log(`  Fighters with upcoming fights: ${hasUpcoming.size}`);

  // Build update lists
  const activeIds  = [];
  const retiredIds = [];

  for (const [id, date] of Object.entries(latestDate)) {
    if (hasUpcoming.has(id) || date >= ACTIVE_CUTOFF) {
      activeIds.push(id);
    } else {
      retiredIds.push(id);
    }
  }
  // Fighters with upcoming fights but no completed fights → active
  for (const id of hasUpcoming) {
    if (!latestDate[id] && !activeIds.includes(id)) activeIds.push(id);
  }

  console.log(`\n  → ${activeIds.length} fighters will be marked active`);
  console.log(`  → ${retiredIds.length} fighters will be marked retired`);

  // Apply in batches of 500
  const BATCH = 500;

  let updated = 0;
  for (let i = 0; i < retiredIds.length; i += BATCH) {
    const batch = retiredIds.slice(i, i + BATCH);
    const { error } = await supabase
      .from('fighters')
      .update({ status: 'retired' })
      .in('id', batch);
    if (error) console.error('Retired update error:', error.message);
    else updated += batch.length;
  }
  console.log(`  Marked ${updated} fighters as retired`);

  updated = 0;
  for (let i = 0; i < activeIds.length; i += BATCH) {
    const batch = activeIds.slice(i, i + BATCH);
    const { error } = await supabase
      .from('fighters')
      .update({ status: 'active' })
      .in('id', batch);
    if (error) console.error('Active update error:', error.message);
    else updated += batch.length;
  }
  console.log(`  Marked ${updated} fighters as active`);

  console.log('\nDone.');
}

main().catch(console.error);
