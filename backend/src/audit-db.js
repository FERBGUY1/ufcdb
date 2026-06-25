/**
 * audit-db.js — Comprehensive DB-only integrity audit (REPORT ONLY, no writes)
 *
 * Checks:
 *   A. Orphaned/invalid references (fights → fighters/events, winner_id sanity)
 *   B. Result/method enum + consistency violations
 *   C. Round/time sanity
 *   D. Bout order & card position integrity
 *   E. Weight class data
 *   F. Duplicate fighters (normalized name)
 *   G. Zero-fight fighters / zero-fight events / stale upcoming
 *   H. Title flag sanity
 *   I. Record consistency (career vs UFC vs pro)
 *   J. Non-UFC event contamination check
 *   K. Phantom-fight window remnants (2026-05-28 scraper)
 *
 * Usage: node -r dotenv/config src/audit-db.js
 */
const supabase = require('./db/client');

const TODAY = new Date().toISOString().split('T')[0];

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function loadAll(table, cols) {
  const all = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) { console.error(`Load error ${table}:`, error.message); break; }
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

const VALID_RESULTS = new Set(['win', 'draw', 'no_contest', 'upcoming']);
const VALID_METHODS = new Set(['KO/TKO', 'SUB', 'U-DEC', 'S-DEC', 'M-DEC', 'DEC', 'NC', 'DQ', 'CNC', 'Draw', 'Overturned']);
const VALID_POSITIONS = new Set(['main_card', 'prelim', 'early_prelim']);
const VALID_STATUS = new Set(['active', 'retired']);

// Early UFC tournament era — multiple fights per fighter per event are legit
const TOURNAMENT_CUTOFF = '2000-01-01';

async function main() {
  console.log('UFCDB — DB Integrity Audit (report only)');
  console.log('=========================================\n');

  const fights = await loadAll('fights',
    'id, event_id, fighter1_id, fighter2_id, winner_id, result, method, method_detail, round, time, bout_order, card_position, weight_class_id, is_title_fight, is_interim_title, catch_weight_lbs, created_at');
  const fighters = await loadAll('fighters',
    'id, first_name, last_name, nickname, slug, status, wins, losses, draws, no_contests, career_wins, career_losses, pro_wins, pro_losses, primary_weight_class_id, weight_lbs, date_of_birth');
  const events = await loadAll('events', 'id, name, slug, date, is_complete, promotion_id');
  const weightClasses = await loadAll('weight_classes', 'id, name, gender, limit_lbs');

  console.log(`Loaded: ${fights.length} fights, ${fighters.length} fighters, ${events.length} events, ${weightClasses.length} weight classes\n`);

  const fighterById = Object.fromEntries(fighters.map(f => [f.id, f]));
  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  const wcById = Object.fromEntries(weightClasses.map(w => [w.id, w]));
  const fname = id => { const f = fighterById[id]; return f ? `${f.first_name} ${f.last_name}` : `<missing:${(id || 'null').slice(0, 8)}>`; };
  const evname = id => { const e = eventById[id]; return e ? `${e.name} (${e.date})` : `<missing:${(id || 'null').slice(0, 8)}>`; };

  const findings = {}; // section → array of strings
  const add = (section, msg) => { (findings[section] = findings[section] || []).push(msg); };

  // ── A. Orphaned / invalid references ──────────────────────────────────────
  for (const f of fights) {
    if (!f.event_id) add('A. Orphaned refs', `Fight ${f.id.slice(0, 8)} has NULL event_id (${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)})`);
    else if (!eventById[f.event_id]) add('A. Orphaned refs', `Fight ${f.id.slice(0, 8)} references missing event ${f.event_id.slice(0, 8)}`);
    if (!f.fighter1_id) add('A. Orphaned refs', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)} has NULL fighter1_id`);
    else if (!fighterById[f.fighter1_id]) add('A. Orphaned refs', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)} references missing fighter1 ${f.fighter1_id.slice(0, 8)}`);
    if (!f.fighter2_id) add('A. Orphaned refs', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)} has NULL fighter2_id`);
    else if (!fighterById[f.fighter2_id]) add('A. Orphaned refs', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)} references missing fighter2 ${f.fighter2_id.slice(0, 8)}`);
    if (f.fighter1_id && f.fighter1_id === f.fighter2_id) add('A. Orphaned refs', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: fighter1 === fighter2 (${fname(f.fighter1_id)})`);
    if (f.winner_id && f.winner_id !== f.fighter1_id && f.winner_id !== f.fighter2_id)
      add('A. Orphaned refs', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: winner_id ${fname(f.winner_id)} is neither fighter`);
  }

  // ── B. Result/method enums + consistency ──────────────────────────────────
  let nullResult = 0, nullMethodCompleted = 0;
  const nullMethodByEra = {};
  for (const f of fights) {
    const ev = eventById[f.event_id];
    const past = ev && ev.date < TODAY;
    if (f.result && !VALID_RESULTS.has(f.result)) add('B. Result/method', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: invalid result '${f.result}'`);
    if (f.method && !VALID_METHODS.has(f.method)) add('B. Result/method', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: non-standard method '${f.method}' (${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)})`);
    if (!f.result) nullResult++;
    if (f.result === 'win') {
      if (!f.winner_id) add('B. Result/method', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: result=win but winner_id NULL`);
      else if (f.winner_id !== f.fighter1_id) add('B. Result/method', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: result=win but winner_id != fighter1_id (convention violation) — winner=${fname(f.winner_id)}`);
    }
    if (['draw', 'no_contest', 'upcoming'].includes(f.result) && f.winner_id)
      add('B. Result/method', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: result=${f.result} but winner_id set (${fname(f.winner_id)})`);
    if (f.result === 'upcoming' && ev && ev.date < TODAY)
      add('B. Result/method (stale upcoming)', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: result=upcoming but event date passed — ${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)}`);
    if (past && (f.result === 'win' || f.result === 'draw') && !f.method) {
      nullMethodCompleted++;
      const era = ev.date < '2000-01-01' ? '1993-1999' : ev.date < '2010-01-01' ? '2000-2009' : ev.date < '2016-01-01' ? '2010-2015' : ev.date < '2022-01-01' ? '2016-2021' : '2022+';
      nullMethodByEra[era] = (nullMethodByEra[era] || 0) + 1;
    }
    // method/result agreement
    if (f.method === 'Draw' && f.result === 'win') add('B. Result/method', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: method=Draw but result=win`);
    if (f.method === 'NC' && f.result === 'win') add('B. Result/method', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: method=NC but result=win`);
  }
  add('B-stats', `Fights with NULL result: ${nullResult} (legacy)`);
  add('B-stats', `Completed fights with NULL method: ${nullMethodCompleted} — by era: ${JSON.stringify(nullMethodByEra)}`);

  // ── C. Round/time sanity ───────────────────────────────────────────────────
  for (const f of fights) {
    if (f.round != null && (f.round < 1 || f.round > 5)) add('C. Round/time', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: round=${f.round} out of range`);
    if (f.time && !/^\d{1,2}:\d{2}$/.test(f.time)) add('C. Round/time', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: malformed time '${f.time}'`);
    if (f.time) {
      const [m, s] = f.time.split(':').map(Number);
      if (m > 5 || s > 59) add('C. Round/time', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: implausible time '${f.time}'`);
    }
    if (['U-DEC', 'S-DEC', 'M-DEC'].includes(f.method) && f.round != null && ![2, 3, 5].includes(f.round))
      add('C. Round/time', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: decision but round=${f.round} (${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)})`);
    if (['KO/TKO', 'SUB'].includes(f.method) && f.round == null) {
      const ev = eventById[f.event_id];
      if (ev && ev.date < TODAY) add('C. Round/time (finish missing round)', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: ${f.method} but round NULL — ${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)}`);
    }
  }

  // ── D. Bout order / card position ──────────────────────────────────────────
  const fightsByEvent = {};
  fights.forEach(f => { if (f.event_id) (fightsByEvent[f.event_id] = fightsByEvent[f.event_id] || []).push(f); });

  let evNoBoutOrder = 0, evPartialBoutOrder = 0, evNoMainEvent = 0, evGaps = 0, evDupGlobal = 0;
  let badPosition = 0;
  for (const f of fights) {
    if (f.card_position && !VALID_POSITIONS.has(f.card_position)) { badPosition++; add('D. Bout order', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: invalid card_position '${f.card_position}'`); }
    if (f.card_position && f.bout_order == null) add('D. Bout order', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: card_position set but bout_order NULL`);
    if (f.bout_order != null && !f.card_position) add('D. Bout order', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: bout_order=${f.bout_order} but card_position NULL`);
    if (f.bout_order != null && f.bout_order < 0) add('D. Bout order', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: negative bout_order ${f.bout_order}`);
  }
  for (const [evId, evFights] of Object.entries(fightsByEvent)) {
    const orders = evFights.filter(f => f.bout_order != null).map(f => f.bout_order);
    if (!orders.length) { evNoBoutOrder++; continue; }
    if (orders.length < evFights.length) { evPartialBoutOrder++; add('D. Bout order', `${evname(evId)}: ${evFights.length - orders.length}/${evFights.length} fights missing bout_order`); }
    if (!orders.includes(0)) { evNoMainEvent++; add('D. Bout order', `${evname(evId)}: no bout_order=0 (no main event) — orders: [${[...orders].sort((a, b) => a - b).join(',')}]`); }
    const sorted = [...orders].sort((a, b) => a - b);
    const expectMax = orders.length - 1;
    if (sorted[sorted.length - 1] !== expectMax || new Set(orders).size !== orders.length) {
      const dups = orders.filter((o, i) => orders.indexOf(o) !== i);
      if (dups.length) { evDupGlobal++; add('D. Bout order', `${evname(evId)}: duplicate bout_order values across sections: [${[...new Set(dups)].join(',')}]`); }
      else { evGaps++; add('D. Bout order (gaps)', `${evname(evId)}: bout_order gaps — have [${sorted.join(',')}]`); }
    }
  }
  add('D-stats', `Events with no bout_order at all: ${evNoBoutOrder} (historical, not yet processed)`);
  add('D-stats', `Events with partial bout_order: ${evPartialBoutOrder}; missing main event (no bo=0): ${evNoMainEvent}; gaps: ${evGaps}; cross-section duplicates: ${evDupGlobal}`);

  // ── E. Weight class data ───────────────────────────────────────────────────
  let nullWcFights = 0;
  const nullWcByEra = {};
  for (const f of fights) {
    if (f.weight_class_id == null) {
      nullWcFights++;
      const ev = eventById[f.event_id];
      if (ev) {
        const era = ev.date < '2000-01-01' ? '1993-1999' : ev.date < '2010-01-01' ? '2000-2009' : ev.date < '2016-01-01' ? '2010-2015' : ev.date < '2022-01-01' ? '2016-2021' : '2022+';
        nullWcByEra[era] = (nullWcByEra[era] || 0) + 1;
      }
    } else if (!wcById[f.weight_class_id]) {
      add('E. Weight class', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: weight_class_id=${f.weight_class_id} not in weight_classes table`);
    }
    if (f.catch_weight_lbs != null && (f.catch_weight_lbs < 100 || f.catch_weight_lbs > 300))
      add('E. Weight class', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: implausible catch_weight ${f.catch_weight_lbs}`);
  }
  add('E-stats', `Fights with NULL weight_class_id: ${nullWcFights} — by era: ${JSON.stringify(nullWcByEra)}`);
  let nullWcFighters = 0, badWcFighters = 0;
  for (const f of fighters) {
    if (f.primary_weight_class_id == null) nullWcFighters++;
    else if (!wcById[f.primary_weight_class_id]) { badWcFighters++; add('E. Weight class', `Fighter ${f.first_name} ${f.last_name}: primary_weight_class_id=${f.primary_weight_class_id} invalid`); }
    if (f.weight_lbs != null && (f.weight_lbs < 100 || f.weight_lbs > 400))
      add('E. Weight class', `Fighter ${f.first_name} ${f.last_name}: implausible weight_lbs=${f.weight_lbs}`);
  }
  add('E-stats', `Fighters with NULL primary_weight_class_id: ${nullWcFighters}`);

  // ── F. Duplicate fighters ──────────────────────────────────────────────────
  const KNOWN_DISTINCT = new Set(['brunosilva']); // two real Bruno Silvas
  const byNorm = {};
  fighters.forEach(f => {
    const n = norm((f.first_name || '') + (f.last_name || ''));
    (byNorm[n] = byNorm[n] || []).push(f);
  });
  for (const [n, list] of Object.entries(byNorm)) {
    if (list.length < 2) continue;
    const note = KNOWN_DISTINCT.has(n) ? ' [KNOWN DISTINCT — verify count]' : '';
    add('F. Duplicate fighters', `"${list[0].first_name} ${list[0].last_name}" x${list.length}: ${list.map(f => `${f.id.slice(0, 8)} (${f.nickname || 'no nick'}, ${f.wins}-${f.losses})`).join(' | ')}${note}`);
  }

  // ── G. Zero-fight fighters / events; is_complete sanity ───────────────────
  const fightersWithFights = new Set();
  fights.forEach(f => { fightersWithFights.add(f.fighter1_id); fightersWithFights.add(f.fighter2_id); });
  const zeroFighters = fighters.filter(f => !fightersWithFights.has(f.id));
  add('G-stats', `Fighters with zero fights in DB: ${zeroFighters.length}`);
  zeroFighters.slice(0, 30).forEach(f => add('G. Zero-fight fighters', `${f.first_name} ${f.last_name} (${f.id.slice(0, 8)}) stored record ${f.wins}-${f.losses}, status=${f.status}`));
  if (zeroFighters.length > 30) add('G. Zero-fight fighters', `...and ${zeroFighters.length - 30} more`);

  const zeroEvents = events.filter(e => !fightsByEvent[e.id]?.length);
  zeroEvents.forEach(e => add('G. Zero-fight events', `${e.name} (${e.date}) ${e.id.slice(0, 8)}`));

  for (const e of events) {
    const evFights = fightsByEvent[e.id] || [];
    if (!evFights.length) continue;
    const allDone = evFights.every(f => f.result && f.result !== 'upcoming');
    if (e.date < TODAY && !e.is_complete && allDone)
      add('G. is_complete', `${e.name} (${e.date}): all ${evFights.length} fights have results but is_complete=false`);
    if (e.is_complete && evFights.some(f => f.result === 'upcoming'))
      add('G. is_complete', `${e.name} (${e.date}): is_complete=true but has upcoming fights`);
  }

  // invalid fighter status
  fighters.filter(f => !VALID_STATUS.has(f.status)).slice(0, 20)
    .forEach(f => add('G. Fighter status', `${f.first_name} ${f.last_name}: status='${f.status}'`));

  // ── H. Title flags ─────────────────────────────────────────────────────────
  let titleCount = 0, interimCount = 0;
  for (const f of fights) {
    if (f.is_title_fight) titleCount++;
    if (f.is_interim_title) {
      interimCount++;
      if (!f.is_title_fight) add('H. Title flags', `Fight ${f.id.slice(0, 8)} @ ${evname(f.event_id)}: is_interim_title=true but is_title_fight=false (${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)})`);
    }
  }
  add('H-stats', `Title fights flagged: ${titleCount} (${interimCount} interim) across ${events.length} events`);
  // numbered UFC events (PPV) with zero title fights — most PPVs have one (informational)
  const ppvNoTitle = [];
  for (const e of events) {
    if (!/^UFC \d+/.test(e.name)) continue;
    if (e.date >= TODAY) continue;
    const evFights = fightsByEvent[e.id] || [];
    if (evFights.length && !evFights.some(f => f.is_title_fight)) ppvNoTitle.push(`${e.name} (${e.date})`);
  }
  add('H-stats', `Numbered (PPV) events with NO title fight flagged: ${ppvNoTitle.length}`);
  ppvNoTitle.forEach(s => add('H. PPV without title fight (verify manually — some are legit)', s));

  // ── I. Record consistency ──────────────────────────────────────────────────
  for (const f of fighters) {
    const ufcTotal = (f.wins || 0) + (f.losses || 0);
    if (f.career_wins != null && f.career_wins > 0 && f.career_wins < (f.wins || 0))
      add('I. Records', `${f.first_name} ${f.last_name}: career_wins ${f.career_wins} < UFC wins ${f.wins}`);
    if (f.pro_wins != null && f.pro_wins < (f.wins || 0))
      add('I. Records', `${f.first_name} ${f.last_name}: pro_wins ${f.pro_wins} < UFC wins ${f.wins} (wrong Sherdog profile or polluted UFC record)`);
    if (f.pro_losses != null && f.pro_losses < (f.losses || 0))
      add('I. Records', `${f.first_name} ${f.last_name}: pro_losses ${f.pro_losses} < UFC losses ${f.losses}`);
    if (ufcTotal > 40) add('I. Records', `${f.first_name} ${f.last_name}: UFC record ${f.wins}-${f.losses} implausibly large (>40 fights — non-UFC contamination?)`);
  }

  // ── J. Non-UFC contamination ───────────────────────────────────────────────
  const nonUfcEvents = events.filter(e => !/UFC|Ultimate|TUF|The Ultimate Fighter|UFN|Fight Night/i.test(e.name));
  add('J-stats', `Events whose name doesn't look like UFC: ${nonUfcEvents.length}`);
  nonUfcEvents.slice(0, 40).forEach(e => add('J. Non-UFC events', `${e.name} (${e.date}) — ${(fightsByEvent[e.id] || []).length} fights`));
  if (nonUfcEvents.length > 40) add('J. Non-UFC events', `...and ${nonUfcEvents.length - 40} more`);

  // ── K. Phantom window ──────────────────────────────────────────────────────
  const phantom = fights.filter(f => f.created_at >= '2026-05-28T00:00:00' && f.created_at < '2026-05-29T00:00:00');
  const phantomNullMethod = phantom.filter(f => !f.method && f.result && f.result !== 'upcoming');
  add('K-stats', `Fights created in 2026-05-28 phantom window: ${phantom.length}; of those, completed with null method: ${phantomNullMethod.length}`);
  phantomNullMethod.slice(0, 25).forEach(f =>
    add('K. Phantom window null-method', `${f.id.slice(0, 8)} @ ${evname(f.event_id)}: ${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)} result=${f.result}`));

  // Pair-at-multiple-events check (phantom signature) — same pair, 2+ events, one with null method
  const pairEvents = {};
  for (const f of fights) {
    if (!f.fighter1_id || !f.fighter2_id) continue;
    const key = [f.fighter1_id, f.fighter2_id].sort().join(':');
    (pairEvents[key] = pairEvents[key] || []).push(f);
  }
  let rematchNullMethod = 0;
  for (const list of Object.values(pairEvents)) {
    if (list.length < 2) continue;
    const evIds = new Set(list.map(f => f.event_id));
    if (evIds.size < 2) continue;
    const sus = list.filter(f => !f.method && f.result === 'win');
    if (sus.length) {
      rematchNullMethod++;
      if (rematchNullMethod <= 20) sus.forEach(f =>
        add('K. Rematch w/ null method (possible phantom)', `${fname(f.fighter1_id)} vs ${fname(f.fighter2_id)} @ ${evname(f.event_id)} (pair appears at ${evIds.size} events)`));
    }
  }
  add('K-stats', `Fighter pairs at 2+ events where one fight has null method: ${rematchNullMethod}`);

  // ── Output ─────────────────────────────────────────────────────────────────
  const sections = Object.keys(findings).sort();
  let totalIssues = 0;
  for (const s of sections) {
    const list = findings[s];
    console.log(`\n── ${s} (${list.length}) ${'─'.repeat(Math.max(1, 50 - s.length))}`);
    list.forEach(m => console.log(`  ${m}`));
    if (!s.includes('-stats')) totalIssues += list.length;
  }
  console.log(`\n=========================================`);
  console.log(`Total non-stat findings: ${totalIssues}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
