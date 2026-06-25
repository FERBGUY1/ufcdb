/**
 * fix-title-fights-fp.js — clear false positive is_title_fight flags
 *
 * Also corrects bout_order/card_position for real title fights that were
 * mis-placed in the wrong section by fix-bout-order.js.
 *
 * Run: node -r dotenv/config fix-title-fights-fp.js [--dry-run]
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

async function patch(id, fields, label) {
  if (DRY) { console.log('  DRY ' + id.slice(0, 8) + ' ' + label + ' → ' + JSON.stringify(fields)); return; }
  const { error } = await supabase.from('fights').update(fields).eq('id', id);
  if (error) console.error('  ERR ' + id.slice(0, 8) + ' ' + label + ': ' + error.message);
  else        console.log( '  OK  ' + id.slice(0, 8) + ' ' + label);
}

async function loadFighters() {
  const all = [];
  let page = 0;
  while (true) {
    const { data } = await supabase.from('fighters').select('id,first_name,last_name')
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return Object.fromEntries(all.map(f => [f.id, f]));
}

async function main() {
  console.log(DRY ? '=== DRY RUN ===' : '=== APPLYING FIXES ===');

  const fighters = await loadFighters();
  const fname = id => {
    const f = fighters[id];
    return f ? `${f.first_name} ${f.last_name}` : id?.slice(0, 8);
  };
  const lname = id => fighters[id]?.last_name?.toLowerCase() || '';

  // ── 1. Clear false positive is_title_fight flags ─────────────────────────────
  // These fights were NOT for any championship belt. The fix-title-fights.js
  // Phase 1 `isTitleText()` function's `\bfor the\b` pattern triggered on notes
  // like "For the #1 contender" or similar, incorrectly flagging them.
  //
  // Evidence: all post-2001 fights ended by decision at round 3 (title fights
  // are scheduled for 5 rounds in the modern era). Confirmed against known
  // fight history.

  console.log('\n=== 1. Clear false positive is_title_fight flags ===');

  const FALSE_POSITIVES = [
    // Event name fragment, fighter1 last, fighter2 last, notes
    ['UFC 121',                     'Shields',        'Kampmann',  'non-title WW fight, both lost to GSP later'],
    ['Velasquez vs Dos Santos',     'Henderson',      'Guida',     'non-title LW, Henderson won belt 3mo later'],
    ['Evans vs Davis',              'Sonnen',         'Bisping',   'non-title MW co-main'],
    ['Fight for the Troops 2',      'Hominick',       'Roop',      'non-title FW prelim fight'],
    ['UFC 190',                     'Gadelha',        'Aguilar',   'non-title SW prelim fight (bo=6 prelim)'],
    ['UFC 200',                     'Cormier',        'Silva',     'non-title catchweight, Anderson late replacement'],
    ['UFC 211',                     'Maia',           'Masvidal',  'non-title WW fight, Woodley was champion'],
    ['UFC 219',                     'Nurmagomedov',   'Barboza',   'non-title LW fight, belt was vacant at time'],
    ['UFC 229',                     'Lewis',          'Volkov',    'non-title HW fight, Khabib vs McGregor was title'],
    ['UFC 300',                     'Tsarukyan',      'Oliveira',  'confirmed: #1 contender bout, not title fight'],
    ['UFC 317',                     'Van',            'Royval',    'DEC R3 proves non-title (title fights = 5 rounds)'],
  ];

  for (const [evFrag, last1, last2, note] of FALSE_POSITIVES) {
    const { data: evs } = await supabase.from('events').select('id,name,date')
      .ilike('name', '%' + evFrag + '%');
    if (!evs?.length) { console.log('  SKIP event not found: ' + evFrag); continue; }

    let found = false;
    for (const ev of evs) {
      const { data: fights } = await supabase.from('fights')
        .select('id,fighter1_id,fighter2_id,method,round,is_title_fight,is_interim_title,bout_order,card_position')
        .eq('event_id', ev.id)
        .eq('is_title_fight', true);

      for (const f of (fights || [])) {
        const l1 = lname(f.fighter1_id);
        const l2 = lname(f.fighter2_id);
        const match = [l1, l2].some(n => n === last1.toLowerCase()) &&
                      [l1, l2].some(n => n === last2.toLowerCase());
        if (!match) continue;

        const label = `${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)} @ ${ev.name} [${ev.date}] — ${note}`;
        await patch(f.id, { is_title_fight: false, is_interim_title: false }, label);
        found = true;
      }
    }
    if (!found) console.log('  SKIP already cleared or not found: ' + evFrag + ' / ' + last1 + ' vs ' + last2);
  }

  // ── 2. Fix bout_order for legitimate title fights placed in wrong section ─────
  // These fights ARE correctly flagged as title fights, but fix-bout-order.js
  // placed them in the wrong card_position / bout_order.
  //
  // For UFC 165, 232, 273, 283: bo=1 main_card is vacant (the DB jumps from
  // bo=0 to bo=2), so we can slot the co-main title fight in cleanly.
  //
  // For UFC 52 (Hughes vs Trigg): bo=1 main_card is occupied; shift down.
  //
  // UFC on FOX Henderson vs Melendez and UFC 306 need full fix-bout-order.js
  // re-run and are noted but not patched here.

  console.log('\n=== 2. Fix legitimate title fights placed in wrong section ===');

  const SECTION_FIXES = [
    // [event name fragment, last1, last2, target_bo, target_section]
    ['UFC 165',   'Barao',   'Wineland',  1, 'main_card'],  // Interim BW title, co-main
    ['UFC 232',   'Nunes',   'Justino',   1, 'main_card'],  // Women's FW title, co-main
    ['UFC 273',   'Sterling','Yan',        1, 'main_card'],  // BW title, co-main
    ['UFC 283',   'Moreno',  'Figueiredo', 1, 'main_card'],  // FW title, co-main
    ['UFC 306',   'Dvalishvili','O\'Malley', 2, 'main_card'], // BW title
  ];

  for (const [evFrag, last1, last2, targetBo, targetSection] of SECTION_FIXES) {
    const { data: evs } = await supabase.from('events').select('id,name,date')
      .ilike('name', '%' + evFrag + '%');
    if (!evs?.length) { console.log('  SKIP event not found: ' + evFrag); continue; }

    let found = false;
    for (const ev of evs) {
      const { data: fights } = await supabase.from('fights')
        .select('id,fighter1_id,fighter2_id,bout_order,card_position,is_title_fight')
        .eq('event_id', ev.id)
        .eq('is_title_fight', true);

      for (const f of (fights || [])) {
        const l1 = lname(f.fighter1_id);
        const l2 = lname(f.fighter2_id);
        const match = [l1, l2].some(n => n === last1.toLowerCase()) &&
                      [l1, l2].some(n => n === last2.toLowerCase());
        if (!match) continue;
        if (f.bout_order === targetBo && f.card_position === targetSection) {
          console.log('  ALREADY OK ' + fname(f.fighter1_id) + ' vs ' + fname(f.fighter2_id) + ' @ ' + ev.name);
          found = true;
          continue;
        }

        // Check for conflict at target position
        const { data: existing } = await supabase.from('fights')
          .select('id,fighter1_id,fighter2_id')
          .eq('event_id', ev.id)
          .eq('bout_order', targetBo)
          .eq('card_position', targetSection);
        if (existing?.length) {
          console.log('  CONFLICT bo=' + targetBo + ' ' + targetSection + ' already has: ' +
            existing.map(x => fname(x.fighter1_id) + ' vs ' + fname(x.fighter2_id)).join(', '));
          continue;
        }

        const label = `${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)} @ ${ev.name}: bo=${f.bout_order} ${f.card_position} → bo=${targetBo} ${targetSection}`;
        await patch(f.id, { bout_order: targetBo, card_position: targetSection }, label);
        found = true;
      }
    }
    if (!found) {
      // Special case: UFC 306 Dvalishvili vs O'Malley needs bo=2..4 shifted down first
      if (evFrag === 'UFC 306') {
        const { data: evs2 } = await supabase.from('events').select('id,name').ilike('name', '%UFC 306%');
        const ev2 = evs2?.[0];
        if (ev2) {
          const { data: ufc306fights } = await supabase.from('fights')
            .select('id,fighter1_id,fighter2_id,bout_order,card_position,is_title_fight')
            .eq('event_id', ev2.id);

          const dvFight = (ufc306fights || []).find(f => {
            const l1 = lname(f.fighter1_id), l2 = lname(f.fighter2_id);
            return ([l1, l2].some(n => n === 'dvalishvili') && [l1, l2].some(n => n.replace(/'/g, '') === 'omalley'));
          });

          if (!dvFight) {
            console.log('  SKIP UFC 306 Dvalishvili vs O\'Malley not found by name');
          } else if (dvFight.bout_order === 2 && dvFight.card_position === 'main_card') {
            console.log('  ALREADY OK Dvalishvili vs O\'Malley @ UFC 306 bo=2 main_card');
          } else {
            // Shift bo=2,3,4 main_card to bo=3,4,5 to make room
            const toShift2 = (ufc306fights || [])
              .filter(f => f.card_position === 'main_card' && f.bout_order >= 2 && f.bout_order <= 4)
              .sort((a, b) => b.bout_order - a.bout_order);
            for (const f of toShift2) {
              const lbl = `${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)} UFC 306 bo=${f.bout_order}→${f.bout_order+1}`;
              await patch(f.id, { bout_order: f.bout_order + 1 }, lbl);
            }
            const lbl = `Dvalishvili vs O'Malley UFC 306: bo=${dvFight.bout_order} ${dvFight.card_position} → bo=2 main_card`;
            await patch(dvFight.id, { bout_order: 2, card_position: 'main_card' }, lbl);
          }
        }
      } else {
        console.log('  SKIP not found: ' + evFrag + ' / ' + last1 + ' vs ' + last2);
      }
    }
  }

  // UFC 52: Hughes vs Trigg — needs to be moved from bo=5 prelim to bo=1 main_card.
  // But bo=1 main_card is occupied (Lindland vs Lutter). Shift existing bo=1..4 main_card
  // down by 1 first, then place Hughes vs Trigg at bo=1 main_card.
  console.log('\n  UFC 52 Hughes vs Trigg — shifting main_card fights to make room...');
  {
    const { data: evs } = await supabase.from('events').select('id,name').ilike('name', '%UFC 52%');
    const ev = evs?.[0];
    if (!ev) { console.log('  SKIP UFC 52 not found'); }
    else {
      const { data: card } = await supabase.from('fights')
        .select('id,fighter1_id,fighter2_id,bout_order,card_position,is_title_fight')
        .eq('event_id', ev.id);

      // Find Hughes vs Trigg
      const htFight = (card || []).find(f => {
        const l1 = lname(f.fighter1_id), l2 = lname(f.fighter2_id);
        return [l1,l2].includes('hughes') && [l1,l2].includes('trigg');
      });
      if (!htFight) {
        console.log('  SKIP Hughes vs Trigg not found at UFC 52');
      } else if (htFight.bout_order === 1 && htFight.card_position === 'main_card') {
        console.log('  ALREADY OK Hughes vs Trigg at bo=1 main_card');
      } else {
        // Shift bo=1,2,3,4 main_card up by 1 (to 2,3,4,5)
        const toShift = (card || [])
          .filter(f => f.card_position === 'main_card' && f.bout_order >= 1 && f.bout_order <= 4)
          .sort((a, b) => b.bout_order - a.bout_order); // sort descending to avoid conflicts

        for (const f of toShift) {
          const label = `${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)}: bo=${f.bout_order}→${f.bout_order + 1} main_card`;
          await patch(f.id, { bout_order: f.bout_order + 1 }, label);
        }
        // Now place Hughes vs Trigg at bo=1 main_card
        const label = `Hughes vs Trigg: bo=${htFight.bout_order} ${htFight.card_position} → bo=1 main_card`;
        await patch(htFight.id, { bout_order: 1, card_position: 'main_card' }, label);
      }
    }
  }

  // ── 3. Remaining known bout_order issues requiring fix-bout-order.js ─────────
  console.log('\n=== 3. Events needing fix-bout-order.js (not fixed here) ===');
  console.log('  UFC on FOX: Henderson vs Melendez — ALL fights mislabeled early_prelim (no main_card fights)');
  console.log('    Henderson vs Melendez (LW title) is at bo=11 early_prelim — should be bo=0 main_card');
  console.log('    Run: node -r dotenv/config src/scrapers/fix-bout-order.js --event "Henderson vs Melendez"');

  console.log('\nDone.' + (DRY ? ' (dry run — no changes applied)' : ''));
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
