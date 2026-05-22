require('dotenv').config();
const supabase = require('../db/client');

async function main() {
  console.log('Building complete fighter style map (paginated)...');
  const styleMap = {};
  let fPage = 0;
  while (true) {
    const { data: batch } = await supabase.from('fighters').select('id, primary_style').not('primary_style','is',null).range(fPage*1000,(fPage+1)*1000-1);
    if (!batch?.length) break;
    batch.forEach(f => { styleMap[f.id] = f.primary_style; });
    if (batch.length < 1000) break;
    fPage++;
  }
  console.log(`${Object.keys(styleMap).length} fighters with style`);

  let updated = 0, page = 0;
  while (true) {
    const { data: fights } = await supabase.from('fights').select('id, fighter1_id, fighter2_id').range(page*200,(page+1)*200-1);
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
    updated += fights.length;
    if (fights.length < 200) break;
    page++;
    if (page % 5 === 0) console.log(`  Page ${page}: ${updated} fights processed`);
  }
  console.log('✓ Done — processed', updated, 'fights');
}
main().catch(console.error);
