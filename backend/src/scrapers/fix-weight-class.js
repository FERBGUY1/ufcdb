/**
 * Assigns primary_weight_class_id to all fighters from their fight history.
 * Handles Supabase 1000-row limit by paginating the fights query.
 *
 * Usage: node src/scrapers/fix-weight-class.js
 */
require('dotenv').config();
const supabase = require('../db/client');

async function main() {
  console.log('Assigning primary_weight_class_id from fights...');

  const wcCounts = {};
  let fPage = 0;
  const FSIZE = 1000;

  // Page through all fights (Supabase max 1000/page)
  while (true) {
    const { data: fights } = await supabase
      .from('fights')
      .select('fighter1_id, fighter2_id, weight_class_id')
      .not('weight_class_id', 'is', null)
      .not('result', 'eq', 'upcoming')
      .range(fPage * FSIZE, (fPage + 1) * FSIZE - 1);

    if (!fights?.length) break;

    for (const f of fights) {
      for (const fid of [f.fighter1_id, f.fighter2_id]) {
        if (!fid) continue;
        if (!wcCounts[fid]) wcCounts[fid] = {};
        wcCounts[fid][f.weight_class_id] = (wcCounts[fid][f.weight_class_id] || 0) + 1;
      }
    }

    console.log(`  Page ${fPage+1}: ${fights.length} fights processed, ${Object.keys(wcCounts).length} unique fighters so far`);
    if (fights.length < FSIZE) break;
    fPage++;
  }

  console.log(`\nTotal unique fighters from fights: ${Object.keys(wcCounts).length}`);

  // Update fighters in batches of 200
  const entries = Object.entries(wcCounts);
  let updated = 0;
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200);
    await Promise.all(batch.map(([fid, counts]) => {
      const primaryWc = Object.entries(counts).sort((a,b) => b[1]-a[1])[0][0];
      return supabase.from('fighters').update({ primary_weight_class_id: parseInt(primaryWc) }).eq('id', fid);
    }));
    updated += batch.length;
    if (i % 1000 === 0 && i > 0) console.log(`  Updated ${updated} fighters...`);
  }

  console.log(`✓ Done — primary_weight_class_id assigned to ${updated} fighters`);
}

main().catch(console.error);
