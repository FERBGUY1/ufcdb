/**
 * Assign primary_style to all fighters using stats-based heuristics.
 * Then backfill fighter_style_at_fight columns in fights table.
 *
 * Usage: node src/scrapers/assign-styles.js
 */
require('dotenv').config();
const supabase = require('../db/client');

function assignStyle(f) {
  const td   = f.td_avg  || 0;
  const tdA  = f.td_acc  || 0;
  const sub  = f.sub_avg || 0;
  const sa   = f.str_acc || 0;
  const slpm = f.slpm    || 0;
  const sapm = f.sapm    || 0;
  const sd   = f.str_def || 0;

  // Must have some meaningful stats
  if (slpm === 0 && td === 0 && sub === 0) return 'All-Rounder';

  // Grappling-dominant: order from most specialized to least
  if (sub > 1.2)                                     return 'BJJ Specialist';
  if (sub > 0.6 && td > 1.5)                        return 'Submission Hunter';
  if (td > 3.0 && tdA > 44 && sub <= 0.4)           return 'Wrestler (Freestyle)';
  if (td > 2.0 && tdA > 38 && sub <= 0.6)           return 'Wrestler (Collegiate)';
  if (td > 1.5 && sub > 0.3)                        return 'Grappler';
  if (td > 2.0 && tdA > 35)                         return 'Grappler';

  // Striking-dominant
  if (slpm > 5.0 && sa > 42 && td < 1.5)            return 'Pressure Fighter';
  if (sd > 62 && sa > 42 && slpm > 2.5 && td < 1.5) return 'Counter Striker';
  if (sa > 48 && slpm > 3.0 && td < 1.5)            return 'Boxer';
  if (slpm > 3.5 && td < 2.0)                       return 'Kickboxer';
  if (sa > 40 && slpm > 2.5 && td < 1.5)            return 'Boxer';

  // Mixed / balanced
  if (td > 1.0 || sub > 0.2)                        return 'Grappler';
  if (slpm > 2.0)                                    return 'Boxer';

  return 'All-Rounder';
}

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  UFCDB — Assign Fighter Styles       ║');
  console.log('╚══════════════════════════════════════╝\n');

  let updated = 0, noStats = 0, page = 0;
  const PAGE = 500;
  const styleCounts = {};

  while (true) {
    const { data: fighters } = await supabase
      .from('fighters')
      .select('id, td_avg, td_acc, sub_avg, str_acc, slpm, sapm, str_def')
      .range(page * PAGE, (page + 1) * PAGE - 1)
      .order('id');

    if (!fighters?.length) break;

    const updates = [];
    for (const f of fighters) {
      const hasStats = f.slpm != null || f.td_avg != null || f.sub_avg != null;
      if (!hasStats) { noStats++; continue; }
      const style = assignStyle(f);
      styleCounts[style] = (styleCounts[style] || 0) + 1;
      updates.push({ id: f.id, style });
    }

    await Promise.all(updates.map(u =>
      supabase.from('fighters').update({ primary_style: u.style }).eq('id', u.id)
    ));
    updated += updates.length;

    if ((page + 1) % 5 === 0) console.log(`  Page ${page+1}: ${updated} assigned so far`);
    if (fighters.length < PAGE) break;
    page++;
  }

  console.log(`  ✓ Styles assigned to ${updated} fighters (${noStats} had no stats)`);
  console.log('\n  Style distribution:');
  Object.entries(styleCounts).sort((a,b) => b[1]-a[1]).forEach(([style, count]) => {
    console.log(`    ${style.padEnd(28)} ${count}`);
  });

  // ── Backfill fight style columns ─────────────────────────
  console.log('\nBackfilling fighter_style_at_fight columns...');

  const styleMap = {};
  let fPage = 0;
  while (true) {
    const { data: batch } = await supabase.from('fighters').select('id, primary_style').not('primary_style','is',null).range(fPage*1000,(fPage+1)*1000-1);
    if (!batch?.length) break;
    batch.forEach(f => { styleMap[f.id] = f.primary_style; });
    if (batch.length < 1000) break;
    fPage++;
  }
  console.log(`  ${Object.keys(styleMap).length} fighters with style`);

  let fightUpdated = 0, fightPage = 0;
  while (true) {
    const { data: fights } = await supabase.from('fights').select('id, fighter1_id, fighter2_id').range(fightPage*200,(fightPage+1)*200-1);
    if (!fights?.length) break;
    await Promise.all(fights.map(fight => {
      const s1 = styleMap[fight.fighter1_id];
      const s2 = styleMap[fight.fighter2_id];
      if (!s1 && !s2) return;
      const patch = {};
      if (s1) patch.fighter1_style_at_fight = s1;
      if (s2) patch.fighter2_style_at_fight = s2;
      return supabase.from('fights').update(patch).eq('id', fight.id);
    }));
    fightUpdated += fights.length;
    if (fights.length < 200) break;
    fightPage++;
  }
  console.log(`  ✓ Updated style columns on ${fightUpdated} fights`);
  console.log('\n✓ Done! Run npm run compute:styles next.');
}

main().catch(console.error);
