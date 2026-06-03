/**
 * Fix bout_order for all events so fights are ordered:
 *   main_card first (main event headliner at bout_order=0, then co-main etc.),
 *   then prelim, then early_prelim.
 *
 * Strategy (per event):
 *   1. Fetch all fights with card_position and fighter names.
 *   2. Group by card_position: main_card, prelim, early_prelim, null.
 *   3. Within main_card: headliner fight first (matched from event name),
 *      rest in ascending existing bout_order.
 *   4. Assign new bout_order 0, 1, 2... across sections:
 *      main_card -> prelim -> early_prelim -> null-position fights.
 *   5. Skip events already in correct order; update only changed fights.
 *
 * Does NOT modify card_position values.
 *
 * Usage: node src/scrapers/fix-bout-order.js
 */
require('dotenv').config();
const supabase = require('../db/client');

const NICKNAME_MAP = {
  'zombie':      'jung',
  'cowboy':      'cerrone',
  'cyborg':      'justino',
  'shogun':      'rua',
  'rampage':     'jackson',
  'bigfoot':     'silva',
  'marreta':     'santos',
  'minotauro':   'nogueira',
  'cop':         'filipovic',
  'notorious':   'mcgregor',
  'stylebender': 'adesanya',
  'blessed':     'holloway',
  'spider':      'silva',
  'eagle':       'nurmagomedov',
};

function parseHeadliners(eventName) {
  const m = eventName.match(/:\s*(.+?)\s+vs\.?\s+(.+)$/i);
  if (!m) return null;
  const extractKey = (s) => {
    const cleaned = s.trim()
      .replace(/\s+(ii|iii|iv|vi|vii|viii|ix)$/i, '')
      .replace(/\s+\d+$/, '')
      .trim();
    const word = cleaned.split(/\s+/).pop().toLowerCase();
    return NICKNAME_MAP[word] || word;
  };
  const last1 = extractKey(m[1]);
  const last2 = extractKey(m[2]);
  if (!last1 || !last2) return null;
  return [last1, last2];
}

function fightMatchesHeadliners(fight, last1, last2) {
  const f1l = (fight.fighter1?.last_name  || '').toLowerCase();
  const f1f = (fight.fighter1?.first_name || '').toLowerCase();
  const f2l = (fight.fighter2?.last_name  || '').toLowerCase();
  const f2f = (fight.fighter2?.first_name || '').toLowerCase();
  const f1Matches = (key) => f1l.includes(key) || f1f.includes(key);
  const f2Matches = (key) => f2l.includes(key) || f2f.includes(key);
  return (
    (f1Matches(last1) && f2Matches(last2)) ||
    (f1Matches(last2) && f2Matches(last1))
  );
}

function sortFightsForEvent(fights, headliners) {
  const byOrder = (a, b) => (a.bout_order ?? 999999) - (b.bout_order ?? 999999);

  const groups = { main_card: [], prelim: [], early_prelim: [], unknown: [] };
  for (const f of fights) {
    const key = f.card_position && groups[f.card_position] ? f.card_position : 'unknown';
    groups[key].push(f);
  }
  for (const key of Object.keys(groups)) groups[key].sort(byOrder);

  // If no card_positions are set at all, treat all fights as one group
  const hasPositions = groups.main_card.length + groups.prelim.length + groups.early_prelim.length > 0;
  if (!hasPositions) {
    const all = groups.unknown.sort(byOrder);
    if (headliners) {
      const [l1, l2] = headliners;
      const idx = all.findIndex(f => fightMatchesHeadliners(f, l1, l2));
      if (idx > 0) all.unshift(...all.splice(idx, 1));
    }
    return all;
  }

  // Put headliner first within main_card
  if (headliners && groups.main_card.length > 0) {
    const [l1, l2] = headliners;
    const idx = groups.main_card.findIndex(f => fightMatchesHeadliners(f, l1, l2));
    if (idx > 0) groups.main_card.unshift(...groups.main_card.splice(idx, 1));
  }

  return [...groups.main_card, ...groups.prelim, ...groups.early_prelim, ...groups.unknown];
}

async function main() {
  console.log('===========================================');
  console.log('  UFCDB -- Fix bout_order (all events)   ');
  console.log('===========================================\n');

  let fixed = 0, alreadyCorrect = 0, noFights = 0, errors = 0;
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
      const { data: fights, error: fe } = await supabase
        .from('fights')
        .select(`
          id, bout_order, card_position,
          fighter1:fighters!fighter1_id ( first_name, last_name ),
          fighter2:fighters!fighter2_id ( first_name, last_name )
        `)
        .eq('event_id', event.id)
        .order('bout_order', { ascending: true, nullsFirst: false });

      if (fe) { console.error('  Fight fetch error for', event.name, ':', fe.message); errors++; continue; }
      if (!fights?.length) { noFights++; continue; }

      const headliners = parseHeadliners(event.name);
      const sorted = sortFightsForEvent(fights, headliners);

      // Check if already in the correct order
      const needsUpdate = sorted.some((f, i) => f.bout_order !== i);
      if (!needsUpdate) { alreadyCorrect++; continue; }

      // Update only fights whose bout_order changed
      let hasError = false;
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].bout_order === i) continue;
        const { error: ue } = await supabase
          .from('fights')
          .update({ bout_order: i })
          .eq('id', sorted[i].id);
        if (ue) { console.error('  Update error fight', sorted[i].id, ':', ue.message); hasError = true; }
      }

      if (hasError) {
        errors++;
        console.error('  FAILED:', event.name);
      } else {
        fixed++;
        const mainFight = sorted[0];
        const f1 = mainFight.fighter1?.last_name || '?';
        const f2 = mainFight.fighter2?.last_name || '?';
        console.log('  Fixed: ' + event.name + ' (' + sorted.length + ' fights, main: ' + f1 + ' vs ' + f2 + ')');
      }
    }

    page++;
    console.log('\nPage ' + page + ' done -- ' + fixed + ' fixed, ' + alreadyCorrect + ' already correct\n');
    if (events.length < PAGE_SIZE) break;
  }

  console.log('===========================================');
  console.log('  ' + fixed + ' events updated');
  console.log('  ' + alreadyCorrect + ' already correct');
  console.log('  ' + noFights + ' events with no fights');
  console.log('  ' + errors + ' errors');
}

main().catch(console.error);
