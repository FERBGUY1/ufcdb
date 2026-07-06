/**
 * One-off: repair UFC 149's card layout (bout_order + card_position) per the
 * Wikipedia card order on 2012_in_UFC#UFC_149, and set the interim-title flags
 * on Barão def. Faber (the year-page table carries no championship marker, so
 * no wiki-driven script can set them).
 *
 * The event predates fix-bout-order.js coverage because its Wikipedia article
 * was merged into the 2012 year page (see reimport-missing-fights.js year-
 * anchor handling). Results/methods were verified correct against Wikipedia
 * on 2026-07-06 — this script deliberately touches ONLY layout + title flags.
 *
 * Aborts without writing unless the event has exactly the 11 expected fights.
 * Run: node -r dotenv/config fix-ufc149-card.js [--dry-run]
 */
require('dotenv').config();
const supabase = require('./src/db/client');

const DRY = process.argv.includes('--dry-run');

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}
const pairKey = (a, b) => [norm(a), norm(b)].sort().join(':');

// Wikipedia card order (2012_in_UFC#UFC_149:_Faber_vs._Barão), winner listed first.
const TARGET = [
  { f1: 'Renan Barao',      f2: 'Urijah Faber',     bout_order: 0,  card_position: 'main_card', title: true },
  { f1: 'Tim Boetsch',      f2: 'Hector Lombard',   bout_order: 1,  card_position: 'main_card' },
  { f1: 'Cheick Kongo',     f2: 'Shawn Jordan',     bout_order: 2,  card_position: 'main_card' },
  { f1: 'James Head',       f2: 'Brian Ebersole',   bout_order: 3,  card_position: 'main_card' },
  { f1: 'Chris Clements',   f2: 'Matthew Riddle',   bout_order: 4,  card_position: 'main_card' },
  { f1: 'Nick Ring',        f2: 'Court McGee',      bout_order: 5,  card_position: 'prelim' },
  { f1: 'Francisco Rivera', f2: 'Roland Delorme',   bout_order: 6,  card_position: 'prelim' },
  { f1: 'Ryan Jimmo',       f2: 'Anthony Perosh',   bout_order: 7,  card_position: 'prelim' },
  { f1: 'Bryan Caraway',    f2: 'Mitch Gagnon',     bout_order: 8,  card_position: 'prelim' },
  { f1: 'Antonio Carvalho', f2: 'Daniel Pineda',    bout_order: 9,  card_position: 'prelim' },
  { f1: 'Anton Kuivanen',   f2: 'Mitch Clarke',     bout_order: 10, card_position: 'prelim' },
];

async function main() {
  console.log(`UFC 149 card repair ${DRY ? '*** DRY RUN ***' : '*** APPLY ***'}\n`);

  const { data: evs, error: evErr } = await supabase.from('events')
    .select('id, name, date').ilike('name', '%UFC 149%');
  if (evErr) throw new Error(evErr.message);
  if (!evs || evs.length !== 1) throw new Error(`expected exactly 1 UFC 149 event, found ${evs?.length ?? 0}`);
  const ev = evs[0];
  console.log(`Event: ${ev.name} (${ev.date})  ${ev.id}`);

  const { data: fights, error: fErr } = await supabase.from('fights')
    .select('id, fighter1_id, fighter2_id, bout_order, card_position, is_title_fight, is_interim_title')
    .eq('event_id', ev.id);
  if (fErr) throw new Error(fErr.message);
  if (fights.length !== TARGET.length)
    throw new Error(`expected ${TARGET.length} fights on the event, found ${fights.length} — aborting, card has changed`);

  const ids = [...new Set(fights.flatMap(f => [f.fighter1_id, f.fighter2_id]))];
  const nameById = {};
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('fighters').select('id, first_name, last_name').in('id', ids.slice(i, i + 100));
    data.forEach(f => { nameById[f.id] = `${f.first_name} ${f.last_name}`; });
  }
  const byPair = {};
  fights.forEach(f => { byPair[pairKey(nameById[f.fighter1_id], nameById[f.fighter2_id])] = f; });

  // Resolve every target before writing anything
  const plan = [];
  for (const t of TARGET) {
    const f = byPair[pairKey(t.f1, t.f2)];
    if (!f) throw new Error(`no DB fight found for ${t.f1} vs ${t.f2} — aborting, nothing written`);
    const patch = { bout_order: t.bout_order, card_position: t.card_position };
    if (t.title) { patch.is_title_fight = true; patch.is_interim_title = true; }
    const changed = f.bout_order !== patch.bout_order || f.card_position !== patch.card_position ||
      (t.title && (!f.is_title_fight || !f.is_interim_title));
    plan.push({ t, f, patch, changed });
  }

  console.log('\nPlan:');
  for (const { t, f, patch, changed } of plan) {
    console.log(`  ${t.f1} vs ${t.f2}`);
    console.log(`    bo=${f.bout_order} ${f.card_position || '-'}${f.is_title_fight ? ' [title]' : ''}  ->  bo=${patch.bout_order} ${patch.card_position}${patch.is_title_fight ? ' [interim title]' : ''}${changed ? '' : '  (no change)'}`);
  }

  if (DRY) { console.log('\nDRY RUN — no writes.'); return; }

  let ok = 0, errs = 0;
  for (const { t, f, patch, changed } of plan) {
    if (!changed) continue;
    const { error } = await supabase.from('fights').update(patch).eq('id', f.id);
    if (error) { errs++; console.error(`  ERR ${t.f1} vs ${t.f2}: ${error.message}`); } else ok++;
  }
  console.log(`\nDone. updated=${ok} errors=${errs}`);
  console.log('NEXT: node -r dotenv/config src/validate.js');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
