/**
 * validate.js — DB integrity checker
 *
 * Checks for common data problems and prints a summary report.
 * Does NOT modify any data.
 *
 * Usage: node src/validate.js
 *        node -r dotenv/config src/validate.js
 */
require('dotenv').config();
const supabase = require('./db/client');

// ── helpers ──────────────────────────────────────────────────────────────────

async function loadAll(table, cols, filters = []) {
  const all = [];
  let page = 0;
  while (true) {
    let q = supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    filters.forEach(([method, ...args]) => { q = q[method](...args); });
    const { data, error } = await q;
    if (error) throw new Error(`loadAll(${table}): ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

// Fetch event names for a list of event_ids (in batches of 100)
async function getEventNames(ids) {
  const map = {};
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const { data } = await supabase
      .from('events')
      .select('id, name, date, is_complete')
      .in('id', unique.slice(i, i + 100));
    data?.forEach(e => { map[e.id] = e; });
  }
  return map;
}

// Fetch fighter names for a list of fighter_ids (in batches of 100)
async function getFighterNames(ids) {
  const map = {};
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const { data } = await supabase
      .from('fighters')
      .select('id, first_name, last_name, wins, losses, draws, no_contests')
      .in('id', unique.slice(i, i + 100));
    data?.forEach(f => { map[f.id] = f; });
  }
  return map;
}

// ── checks ────────────────────────────────────────────────────────────────────

/**
 * 1. Duplicate fights — same fighter pair appearing more than once at the same event.
 *    Ignores pre-2000 events (early UFC tournament nights are legitimate).
 */
async function checkDuplicateFights(fights, events) {
  const issues = [];
  const byEvent = {};
  fights.forEach(f => {
    if (!byEvent[f.event_id]) byEvent[f.event_id] = [];
    byEvent[f.event_id].push(f);
  });

  for (const [evId, evFights] of Object.entries(byEvent)) {
    const ev = events[evId];
    if (!ev || ev.date <= '1999-12-31') continue; // skip tournament era

    const seen = new Set();
    evFights.forEach(f => {
      const key = [f.fighter1_id, f.fighter2_id].sort().join('|');
      if (seen.has(key)) {
        issues.push({
          event: ev.name,
          date: ev.date,
          fight_id: f.id,
          fighters: key,
        });
      }
      seen.add(key);
    });
  }
  return issues;
}

/**
 * 2. Fights where result = 'win' but winner_id is NULL.
 */
async function checkNullWinners(fights, fighters, events) {
  return fights
    .filter(f => f.result === 'win' && !f.winner_id)
    .map(f => ({
      fight_id: f.id,
      event: events[f.event_id]?.name ?? f.event_id,
      date: events[f.event_id]?.date,
      fighter1: fighters[f.fighter1_id]
        ? `${fighters[f.fighter1_id].first_name} ${fighters[f.fighter1_id].last_name}`
        : f.fighter1_id,
      fighter2: fighters[f.fighter2_id]
        ? `${fighters[f.fighter2_id].first_name} ${fighters[f.fighter2_id].last_name}`
        : f.fighter2_id,
    }));
}

/**
 * 3. bout_order conflicts — two fights sharing the same bout_order within
 *    the same (event_id, card_position) combination.
 */
async function checkBoutOrderConflicts(fights, events) {
  const issues = [];
  const seen = {};

  fights.forEach(f => {
    if (f.bout_order == null || !f.card_position) return;
    const key = `${f.event_id}|${f.card_position}|${f.bout_order}`;
    if (!seen[key]) { seen[key] = []; }
    seen[key].push(f.id);
  });

  for (const [key, ids] of Object.entries(seen)) {
    if (ids.length < 2) continue;
    const [evId, section, bo] = key.split('|');
    issues.push({
      event: events[evId]?.name ?? evId,
      date: events[evId]?.date,
      section,
      bout_order: Number(bo),
      fight_ids: ids,
    });
  }
  return issues;
}

/**
 * 4. Fighter record mismatches — stored wins/losses/draws/no_contests vs
 *    what's recalculated from the fights table.
 *
 *    Only counts completed UFC fights (result != 'upcoming', result != null).
 */
async function checkFighterRecords(fights, fighters) {
  const calc = {};
  const ensure = id => {
    if (!calc[id]) calc[id] = { wins: 0, losses: 0, draws: 0, no_contests: 0 };
  };

  fights.forEach(f => {
    if (!f.result || f.result === 'upcoming') return;
    ensure(f.fighter1_id);
    ensure(f.fighter2_id);
    if (f.result === 'win') {
      const winnerId = f.winner_id || f.fighter1_id;
      const loserId  = winnerId === f.fighter1_id ? f.fighter2_id : f.fighter1_id;
      ensure(winnerId);
      ensure(loserId);
      calc[winnerId].wins++;
      calc[loserId].losses++;
    } else if (f.result === 'draw') {
      calc[f.fighter1_id].draws++;
      calc[f.fighter2_id].draws++;
    } else if (f.result === 'no_contest') {
      calc[f.fighter1_id].no_contests++;
      calc[f.fighter2_id].no_contests++;
    }
  });

  const issues = [];
  for (const [id, c] of Object.entries(calc)) {
    const stored = fighters[id];
    if (!stored) continue;
    const mismatches = [];
    if (stored.wins       !== c.wins)        mismatches.push(`wins: stored=${stored.wins} calc=${c.wins}`);
    if (stored.losses     !== c.losses)      mismatches.push(`losses: stored=${stored.losses} calc=${c.losses}`);
    if (stored.draws      !== c.draws)       mismatches.push(`draws: stored=${stored.draws} calc=${c.draws}`);
    if (stored.no_contests !== c.no_contests) mismatches.push(`NC: stored=${stored.no_contests} calc=${c.no_contests}`);
    if (mismatches.length) {
      issues.push({
        fighter: `${stored.first_name} ${stored.last_name}`,
        fighter_id: id,
        mismatches,
      });
    }
  }
  return issues;
}

/**
 * 5. Fighters appearing in 2+ fights at the same modern event (post-1999).
 *    Distinct from check #1: this catches a fighter paired with *different*
 *    opponents at the same event (always a data error in the modern era).
 */
async function checkFighterDoubleBooked(fights, fighters, events) {
  const issues = [];
  const byEvent = {};
  fights.forEach(f => {
    if (!byEvent[f.event_id]) byEvent[f.event_id] = [];
    byEvent[f.event_id].push(f);
  });

  for (const [evId, evFights] of Object.entries(byEvent)) {
    const ev = events[evId];
    if (!ev || ev.date <= '1999-12-31') continue;

    const fighterFights = {};
    evFights.forEach(f => {
      [f.fighter1_id, f.fighter2_id].forEach(fid => {
        if (!fighterFights[fid]) fighterFights[fid] = [];
        fighterFights[fid].push(f.id);
      });
    });

    for (const [fid, fids] of Object.entries(fighterFights)) {
      if (fids.length < 2) continue;
      const f = fighters[fid];
      issues.push({
        fighter: f ? `${f.first_name} ${f.last_name}` : fid,
        fighter_id: fid,
        event: ev.name,
        date: ev.date,
        fight_count: fids.length,
        fight_ids: fids,
      });
    }
  }
  return issues;
}

// ── report ────────────────────────────────────────────────────────────────────

function section(title, count, ok = 'none') {
  const status = count === 0 ? `✓ ${ok}` : `✗ ${count} issue${count !== 1 ? 's' : ''}`;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}  ${status}`);
  console.log('─'.repeat(60));
}

async function main() {
  console.log('UFCDB Validation Report');
  console.log('=======================');
  console.log('Loading data...\n');

  const fights = await loadAll('fights', 'id, event_id, fighter1_id, fighter2_id, winner_id, result, bout_order, card_position');
  console.log(`  ${fights.length} fights loaded`);

  // Collect IDs we need
  const eventIds  = [...new Set(fights.map(f => f.event_id))];
  const fighterIds = [...new Set(fights.flatMap(f => [f.fighter1_id, f.fighter2_id]))];

  const events   = await getEventNames(eventIds);
  const fighters = await getFighterNames(fighterIds);
  console.log(`  ${Object.keys(events).length} events, ${Object.keys(fighters).length} fighters loaded`);

  // ── 1. Duplicate fights ───────────────────────────────────────────────────
  const dupes = await checkDuplicateFights(fights, events);
  section('1. Duplicate fights (same pair, same event, post-1999)', dupes.length, 'no duplicates');
  if (dupes.length) {
    dupes.forEach(d => console.log(`  [${d.date}] ${d.event}\n    fight_id: ${d.fight_id}`));
  }

  // ── 2. Null winner_id on wins ─────────────────────────────────────────────
  const nullWins = await checkNullWinners(fights, fighters, events);
  section('2. result="win" but winner_id is NULL', nullWins.length, 'all wins have winner_id');
  if (nullWins.length) {
    nullWins.slice(0, 20).forEach(d =>
      console.log(`  [${d.date}] ${d.event}\n    ${d.fighter1} vs ${d.fighter2}  (${d.fight_id})`)
    );
    if (nullWins.length > 20) console.log(`  ... and ${nullWins.length - 20} more`);
  }

  // ── 3. Bout-order conflicts ───────────────────────────────────────────────
  const boConflicts = await checkBoutOrderConflicts(fights, events);
  section('3. bout_order conflicts (same order within same section)', boConflicts.length, 'no conflicts');
  if (boConflicts.length) {
    boConflicts.forEach(d =>
      console.log(`  [${d.date}] ${d.event}  section=${d.section}  bout_order=${d.bout_order}\n    fight_ids: ${d.fight_ids.join(', ')}`)
    );
  }

  // ── 4. Fighter record mismatches ─────────────────────────────────────────
  const recMismatches = await checkFighterRecords(fights, fighters);
  section('4. Fighter record mismatches (stored vs calculated)', recMismatches.length, 'all records match');
  if (recMismatches.length) {
    recMismatches.slice(0, 20).forEach(d =>
      console.log(`  ${d.fighter} (${d.fighter_id.slice(0, 8)})\n    ${d.mismatches.join(' · ')}`)
    );
    if (recMismatches.length > 20) console.log(`  ... and ${recMismatches.length - 20} more`);
  }

  // ── 5. Double-booked fighters ─────────────────────────────────────────────
  const doubleBooked = await checkFighterDoubleBooked(fights, fighters, events);
  section('5. Fighters in 2+ fights at same modern event', doubleBooked.length, 'none found');
  if (doubleBooked.length) {
    doubleBooked.slice(0, 20).forEach(d =>
      console.log(`  ${d.fighter}  [${d.date}] ${d.event}  (${d.fight_count} fights)`)
    );
    if (doubleBooked.length > 20) console.log(`  ... and ${doubleBooked.length - 20} more`);
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const total = dupes.length + nullWins.length + boConflicts.length +
                recMismatches.length + doubleBooked.length;
  console.log(`\n${'═'.repeat(60)}`);
  if (total === 0) {
    console.log('  All checks passed — no issues found.');
  } else {
    console.log(`  Total issues found: ${total}`);
    console.log(`    Duplicate fights:        ${dupes.length}`);
    console.log(`    Null winner_id on wins:  ${nullWins.length}`);
    console.log(`    bout_order conflicts:    ${boConflicts.length}`);
    console.log(`    Record mismatches:       ${recMismatches.length}`);
    console.log(`    Double-booked fighters:  ${doubleBooked.length}`);
  }
  console.log('═'.repeat(60));
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
