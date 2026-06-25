/**
 * add-cain-velasquez.js
 *
 * Adds Cain Velasquez to the fighters table and inserts all 15 of his UFC fights.
 *
 * Also fixes 4 fights that were incorrectly assigned bout_order=0 because Velasquez's
 * main-event fights were missing (UFC 155, 160, 166, and the Ngannou event).
 *
 * Sources: Wikipedia (fight history), UFC.com (fighter profile)
 *
 * Run: node -r dotenv/config add-cain-velasquez.js [--dry-run]
 * Then: node -r dotenv/config src/scrapers/fix-fighter-records.js
 *       node src/validate.js
 */
require('dotenv').config();
const supabase = require('./src/db/client');

const DRY = process.argv.includes('--dry-run');

async function findFighter(firstName, lastName) {
  const { data } = await supabase.from('fighters').select('id,first_name,last_name')
    .ilike('last_name', '%' + lastName + '%');
  const match = data?.find(f => !firstName || f.first_name?.toLowerCase().includes(firstName.toLowerCase()));
  if (!match) throw new Error('Fighter not found: ' + firstName + ' ' + lastName);
  return match.id;
}

async function findEvent(fragment) {
  const { data } = await supabase.from('events').select('id,name,date').ilike('name', '%' + fragment + '%');
  if (!data?.length) throw new Error('Event not found: ' + fragment);
  if (data.length > 1) {
    // Prefer exact fragment match
    const exact = data.find(e => e.name.toLowerCase().includes(fragment.toLowerCase()));
    return exact?.id || data[0].id;
  }
  return data[0].id;
}

async function main() {
  console.log(DRY ? '\n=== DRY RUN ===' : '\n=== ADDING CAIN VELASQUEZ ===');

  // ── 1. Look up all opponent IDs ───────────────────────────────────────────────
  console.log('\nLoading opponent IDs...');
  const [
    bradMorrisId,
    jakeOBrienId,
    denisStojnicId,
    cheickKongoId,
    benRothwellId,
    nogueiraId,
    lesnarId,
    jdsId,
    antonioSilvaId,
    werdumId,
    browneId,
    ngannouId,
  ] = await Promise.all([
    findFighter('Brad',     'Morris'),
    findFighter('Jake',     'O\'Brien'),
    findFighter('Denis',    'Stojnic'),
    findFighter('Cheick',   'Kongo'),
    findFighter('Ben',      'Rothwell'),
    findFighter('Antonio',  'Nogueira'),
    findFighter('Brock',    'Lesnar'),
    findFighter('Junior',   'Santos'),
    findFighter('Antonio',  'Silva'),
    findFighter('Fabricio', 'Werdum'),
    findFighter('Travis',   'Browne'),
    findFighter('Francis',  'Ngannou'),
  ]);

  console.log('  All 12 opponents found.');

  // ── 2. Look up all event IDs ──────────────────────────────────────────────────
  console.log('\nLoading event IDs...');
  const [
    evUFC83,
    evSilvaIrvin,
    evLauzonStephens,
    evUFC99,
    evUFC104,
    evUFC110,
    evUFC121,
    evFOX1,
    evUFC146,
    evUFC155,
    evUFC160,
    evUFC166,
    evUFC188,
    evUFC200,
    evNgannou,
  ] = await Promise.all([
    findEvent('UFC 83:'),
    findEvent('Silva vs Irvin'),
    findEvent('Lauzon vs Stephens'),
    findEvent('UFC 99:'),
    findEvent('UFC 104:'),
    findEvent('UFC 110:'),
    findEvent('UFC 121:'),
    findEvent('UFC on FOX: Velasquez vs Dos Santos'),
    findEvent('UFC 146:'),
    findEvent('UFC 155:'),
    findEvent('UFC 160:'),
    findEvent('UFC 166:'),
    findEvent('UFC 188:'),
    findEvent('UFC 200:'),
    findEvent('Ngannou vs. Velasquez'),
  ]);

  console.log('  All 15 events found.');

  // ── 3. Insert Cain Velasquez fighter ─────────────────────────────────────────
  console.log('\nInserting Cain Velasquez...');
  const velasquezProfile = {
    first_name:               'Cain',
    last_name:                'Velasquez',
    slug:                     'cain-velasquez',
    primary_weight_class_id:  1,        // Heavyweight
    status:                   'retired',
    is_champion:              false,
    is_interim_champ:         false,
    height_inches:            73,        // 6'1"
    reach_inches:             77,
    weight_lbs:               241,
    stance:                   'Orthodox',
    nationality:              'United States',
    hometown:                 'Salinas, California',
    date_of_birth:            '1982-07-28',
    gym_name:                 'American Kickboxing Academy',
    primary_style:            'Wrestling',
    fighting_style:           'Wrestling, Boxing, Muay Thai',
    ufc_debut_date:           '2008-04-19',
    ufc_debut_event:          'UFC 83: Serra vs St-Pierre 2',
    pro_debut_date:           '2008-04-19',
    // Record is recalculated by fix-fighter-records.js; set accurate values here too
    wins:                     12,
    losses:                   3,
    draws:                    0,
    no_contests:              0,
    wins_ko:                  10,
    wins_sub:                 0,
    wins_dec:                 2,
    losses_ko:                2,
    losses_sub:               1,
    losses_dec:               0,
    career_wins:              12,
    career_losses:            3,
    career_draws:             0,
    career_no_contests:       0,
  };

  let cainId;
  if (!DRY) {
    const { data, error } = await supabase.from('fighters').insert(velasquezProfile).select('id').single();
    if (error) throw new Error('Fighter insert failed: ' + error.message);
    cainId = data.id;
    console.log('  Inserted: Cain Velasquez (' + cainId.slice(0, 8) + ')');
  } else {
    cainId = '<<DRY_RUN_ID>>';
    console.log('  DRY: would insert Cain Velasquez');
  }

  // ── 4. Fix wrong bout_order=0 assignments ────────────────────────────────────
  // These fights got bo=0 because Velasquez's main-event fight was missing.
  console.log('\nFixing incorrect bo=0 assignments...');

  // Lookup fights that incorrectly hold bo=0 — find by event + bout_order=0
  // UFC 155, 160, 166 each have a non-Velasquez fight at bo=0 because the
  // main event (Velasquez's fight) was never inserted.
  const wrongBoEvents = [
    { evId: evUFC155, note: 'UFC 155: was main event slot', extraPatch: {} },
    { evId: evUFC160, note: 'UFC 160: was main event slot', extraPatch: {} },
    { evId: evUFC166, note: 'UFC 166: was main event slot', extraPatch: {} },
    { evId: evNgannou, note: 'Ngannou event: Bermudez/Lopez should be early_prelim',
      extraPatch: { card_position: 'early_prelim' } },
  ];

  for (const { evId, note, extraPatch } of wrongBoEvents) {
    if (DRY) {
      console.log('  DRY: would nullify bo=0 at event ' + evId.slice(0, 8) + ' — ' + note);
      continue;
    }
    const { data: existing } = await supabase.from('fights')
      .select('id').eq('event_id', evId).eq('bout_order', 0);
    if (!existing?.length) { console.log('  SKIP (no bo=0 fight): ' + note); continue; }
    const { error } = await supabase.from('fights')
      .update({ bout_order: null, ...extraPatch }).eq('id', existing[0].id);
    if (error) console.error('  ERR ' + note + ': ' + error.message);
    else console.log('  OK  ' + existing[0].id.slice(0, 8) + ' → bout_order=null — ' + note);
  }

  // ── 5. Define all 15 UFC fights ───────────────────────────────────────────────
  // Convention: fighter1_id = winner, fighter2_id = loser
  // Velasquez wins (12): f1=Cain, f2=opponent
  // Velasquez losses (3): f1=opponent, f2=Cain
  const HW = 1; // Heavyweight weight_class_id

  const fights = [
    // ── Non-title fights ──────────────────────────────────────────────────────
    {
      event_id:      evUFC83,
      fighter1_id:   cainId,   fighter2_id: bradMorrisId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 1, time: '2:10',
      is_title_fight: false,
      bout_order: null, card_position: null,
      _note: 'UFC 83: Velasquez def. Morris',
    },
    {
      event_id:      evSilvaIrvin,
      fighter1_id:   cainId,   fighter2_id: jakeOBrienId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 1, time: '2:02',
      is_title_fight: false,
      bout_order: null, card_position: null,
      _note: 'UFC: Silva vs Irvin — Velasquez def. O\'Brien',
    },
    {
      event_id:      evLauzonStephens,
      fighter1_id:   cainId,   fighter2_id: denisStojnicId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 2, time: '2:34',
      is_title_fight: false,
      bout_order: null, card_position: null,
      _note: 'UFC FN: Lauzon vs Stephens — Velasquez def. Stojnic',
    },
    {
      event_id:      evUFC99,
      fighter1_id:   cainId,   fighter2_id: cheickKongoId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'U-DEC',
      round: 3, time: '5:00',
      is_title_fight: false,
      bout_order: null, card_position: null,
      _note: 'UFC 99: Velasquez def. Kongo',
    },
    {
      event_id:      evUFC104,
      fighter1_id:   cainId,   fighter2_id: benRothwellId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 2, time: '0:58',
      is_title_fight: false,
      bout_order: null, card_position: null,
      _note: 'UFC 104: Velasquez def. Rothwell',
    },
    {
      event_id:      evUFC110,
      fighter1_id:   cainId,   fighter2_id: nogueiraId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 1, time: '2:20',
      is_title_fight: false,
      bout_order: 0, card_position: 'main_card',
      _note: 'UFC 110: Velasquez def. Nogueira (main event)',
    },
    // ── Title fight 1: UFC 121 — Velasquez wins belt from Lesnar ─────────────
    {
      event_id:      evUFC121,
      fighter1_id:   cainId,   fighter2_id: lesnarId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 1, time: '4:12',
      is_title_fight: true, is_interim_title: false,
      bout_order: 0, card_position: 'main_card',
      _note: 'UFC 121: Velasquez def. Lesnar — wins HW title',
    },
    // ── Title fight 2: UFC on FOX 1 — JDS wins belt ───────────────────────────
    {
      event_id:      evFOX1,
      fighter1_id:   jdsId,   fighter2_id: cainId,
      winner_id:     jdsId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 1, time: '1:04',
      is_title_fight: true, is_interim_title: false,
      bout_order: 0, card_position: 'main_card',
      _note: 'UFC on FOX 1: JDS def. Velasquez — JDS wins HW title',
    },
    // ── Non-title fight: UFC 146 ─────────────────────────────────────────────
    {
      event_id:      evUFC146,
      fighter1_id:   cainId,   fighter2_id: antonioSilvaId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 1, time: '3:36',
      is_title_fight: false,
      bout_order: null, card_position: 'main_card',
      _note: 'UFC 146: Velasquez def. A. Silva (co-main)',
    },
    // ── Title fight 3: UFC 155 — Velasquez wins belt back ────────────────────
    {
      event_id:      evUFC155,
      fighter1_id:   cainId,   fighter2_id: jdsId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'U-DEC',
      round: 5, time: '5:00',
      is_title_fight: true, is_interim_title: false,
      bout_order: 0, card_position: 'main_card',
      _note: 'UFC 155: Velasquez def. JDS 2 — wins HW title',
    },
    // ── Title fight 4: UFC 160 — Velasquez defends vs A. Silva ───────────────
    {
      event_id:      evUFC160,
      fighter1_id:   cainId,   fighter2_id: antonioSilvaId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 1, time: '1:21',
      is_title_fight: true, is_interim_title: false,
      bout_order: 0, card_position: 'main_card',
      _note: 'UFC 160: Velasquez def. A. Silva 2 — defends HW title',
    },
    // ── Title fight 5: UFC 166 — Velasquez defends vs JDS 3 ─────────────────
    {
      event_id:      evUFC166,
      fighter1_id:   cainId,   fighter2_id: jdsId,
      winner_id:     cainId,   result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 5, time: '3:09',
      is_title_fight: true, is_interim_title: false,
      bout_order: 0, card_position: 'main_card',
      _note: 'UFC 166: Velasquez def. JDS 3 — defends HW title',
    },
    // ── Title fight 6: UFC 188 — Werdum wins belt ────────────────────────────
    {
      event_id:      evUFC188,
      fighter1_id:   werdumId,  fighter2_id: cainId,
      winner_id:     werdumId,  result: 'win',
      weight_class_id: HW,
      method: 'SUB', method_detail: 'Guillotine choke',
      round: 3, time: '2:13',
      is_title_fight: true, is_interim_title: false,
      bout_order: 0, card_position: 'main_card',
      _note: 'UFC 188: Werdum def. Velasquez — Werdum wins HW title',
    },
    // ── Non-title fight: UFC 200 ─────────────────────────────────────────────
    {
      event_id:      evUFC200,
      fighter1_id:   cainId,    fighter2_id: browneId,
      winner_id:     cainId,    result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 1, time: '4:57',
      is_title_fight: false,
      bout_order: null, card_position: 'main_card',
      _note: 'UFC 200: Velasquez def. Browne',
    },
    // ── Non-title fight: Ngannou event — Ngannou wins ────────────────────────
    {
      event_id:      evNgannou,
      fighter1_id:   ngannouId,  fighter2_id: cainId,
      winner_id:     ngannouId,  result: 'win',
      weight_class_id: HW,
      method: 'KO/TKO', method_detail: 'Punches',
      round: 1, time: '0:26',
      is_title_fight: false,
      bout_order: 0, card_position: 'main_card',
      _note: 'UFC FN: Ngannou def. Velasquez (main event)',
    },
  ];

  // ── 6. Insert the fights ──────────────────────────────────────────────────────
  console.log('\nInserting ' + fights.length + ' Velasquez UFC fights...');
  let inserted = 0, errors = 0;

  for (const fight of fights) {
    const { _note, ...row } = fight;
    if (DRY) {
      const f1 = row.fighter1_id === cainId ? 'Cain' : row.fighter1_id.slice(0, 8);
      const f2 = row.fighter2_id === cainId ? 'Cain' : row.fighter2_id.slice(0, 8);
      console.log('  DRY: ' + _note + ' | ' + row.method + ' R' + row.round + ' ' + row.time + (row.is_title_fight ? ' TITLE' : ''));
    } else {
      const { error } = await supabase.from('fights').insert(row);
      if (error) {
        console.error('  ERR ' + _note + ': ' + error.message);
        errors++;
      } else {
        console.log('  OK  ' + _note);
        inserted++;
      }
    }
  }

  console.log('\n══════════════════════════════════════════');
  if (DRY) {
    console.log('  DRY RUN — no changes applied');
    console.log('  Would insert: Cain Velasquez + ' + fights.length + ' fights');
    console.log('  Would fix:    4 incorrect bout_order=0 assignments');
  } else {
    console.log('  Inserted: ' + inserted + '/' + fights.length + ' fights (' + errors + ' errors)');
    console.log('\n  Next steps:');
    console.log('  node -r dotenv/config src/scrapers/fix-fighter-records.js');
    console.log('  node src/validate.js');
    console.log('  node -r dotenv/config src/scrapers/fix-bout-order.js --event "Ngannou vs. Velasquez"');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
