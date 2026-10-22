/**
 * log-predictions.js — write the predictor's pick for every scheduled bout to
 * prediction_log BEFORE the event (migration 2026-10-15-prediction-log.sql).
 *
 * The log is append-only and the first pick per bout is locked: a bout already
 * logged for this event (same two fighters, either order) is skipped, even if
 * its weight class, rounds or the model have changed since. The database
 * enforces the same rules (insert refused once the event date has passed,
 * prediction columns frozen, no deletes).
 *
 * Per bout: generatePrediction() as served on the Predict page — fight's weight
 * class, scheduled rounds from fights.time_format (else 5 for bo0 / title
 * bouts, 3 otherwise), no narrative, no cache. Predicted winner = the higher
 * win %; predicted method = that fighter's most likely of KO/TKO, SUB, DEC.
 *
 * --void-missing: before logging, grade 'void' every ungraded log row on the
 * event whose pair is no longer on the card ('matchup_changed' when either
 * fighter is still booked on the card, else 'cancelled'). Irreversible, so
 * only upcoming-cards.js passes it, and only right after a clean card sync.
 *
 * Flags: --event-id UUID[,UUID]  events to log (required unless --upcoming)
 *        --upcoming              every event dated today or later
 *        --void-missing          see above
 *        --dry-run               print the picks, write nothing
 *
 * Run: node -r dotenv/config src/scrapers/log-predictions.js --event-id <uuid> [--dry-run]
 */
require('dotenv').config();
const supabase = require('../db/client');
const { generatePrediction } = require('../ml/predictionEngine');

const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const DRY = process.argv.includes('--dry-run');
const UPCOMING = process.argv.includes('--upcoming');
const VOID_MISSING = process.argv.includes('--void-missing');
const EVENT_IDS = (arg('--event-id') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!EVENT_IDS.length && !UPCOMING) {
  console.error('Usage: log-predictions.js --event-id <uuid>[,<uuid>] | --upcoming  [--void-missing] [--dry-run]');
  process.exit(1);
}

const todayUtc = () => new Date().toISOString().slice(0, 10);
const pairKey = (a, b) => [a, b].sort().join('|');
const roundsFor = f => {
  const m = (f.time_format || '').match(/^(\d)\s*Rnd/);
  if (m && (m[1] === '3' || m[1] === '5')) return +m[1];
  return f.bout_order === 0 || f.is_title_fight ? 5 : 3;
};

async function logEvent(ev) {
  if (ev.date < todayUtc()) {
    console.log(`${ev.name} (${ev.date}): event date has passed — nothing logged`);
    return { logged: 0, skipped: 0, voided: 0, errors: 0 };
  }
  const { data: fights, error: fe } = await supabase.from('fights')
    .select('id, fighter1_id, fighter2_id, result, bout_order, weight_class_id, is_title_fight, time_format')
    .eq('event_id', ev.id).order('bout_order');
  if (fe) throw new Error(`fights: ${fe.message}`);
  const { data: logged, error: le } = await supabase.from('prediction_log')
    .select('id, fighter1_id, fighter2_id, fighter1_name, fighter2_name, outcome, graded_at')
    .eq('event_id', ev.id);
  if (le) throw new Error(`prediction_log: ${le.message}`);

  const ids = [...new Set(fights.flatMap(f => [f.fighter1_id, f.fighter2_id]).filter(Boolean))];
  const { data: fighters } = ids.length
    ? await supabase.from('fighters').select('id, first_name, last_name').in('id', ids)
    : { data: [] };
  const nameOf = Object.fromEntries((fighters || []).map(f => [f.id, `${f.first_name} ${f.last_name}`.trim()]));

  console.log(`${ev.name} (${ev.date}): ${fights.length} bouts on card, ${logged.length} already logged`);
  const out = { logged: 0, skipped: 0, voided: 0, errors: 0 };

  // ── void logged picks whose matchup is gone ───────────────────────────────
  const onCard = new Set(fights.filter(f => f.fighter1_id && f.fighter2_id).map(f => pairKey(f.fighter1_id, f.fighter2_id)));
  const booked = new Set(fights.flatMap(f => [f.fighter1_id, f.fighter2_id]).filter(Boolean));
  for (const r of logged) {
    if (r.graded_at || onCard.has(pairKey(r.fighter1_id, r.fighter2_id))) continue;
    const reason = booked.has(r.fighter1_id) || booked.has(r.fighter2_id) ? 'matchup_changed' : 'cancelled';
    if (!VOID_MISSING) { console.log(`  not on card (pass --void-missing to void): ${r.fighter1_name} vs ${r.fighter2_name}`); continue; }
    if (DRY) { console.log(`  [dry] void ${reason}: ${r.fighter1_name} vs ${r.fighter2_name}`); out.voided++; continue; }
    const { error } = await supabase.from('prediction_log')
      .update({ outcome: 'void', void_reason: reason, correct: null, graded_at: new Date().toISOString() })
      .eq('id', r.id).is('graded_at', null);
    console.log(`  void ${reason}: ${r.fighter1_name} vs ${r.fighter2_name}${error ? '  ERROR ' + error.message : ''}`);
    if (error) out.errors++; else out.voided++;
  }

  // ── log new bouts ─────────────────────────────────────────────────────────
  const loggedPairs = new Set(logged.map(r => pairKey(r.fighter1_id, r.fighter2_id)));
  for (const f of fights) {
    const label = `bo${String(f.bout_order).padStart(2)} ${nameOf[f.fighter1_id] || '?'} vs ${nameOf[f.fighter2_id] || '?'}`;
    if (f.result !== 'upcoming') { console.log(`  skip ${label}: result=${f.result}`); out.skipped++; continue; }
    if (!f.fighter1_id || !f.fighter2_id) { console.log(`  skip ${label}: no fighter row`); out.skipped++; continue; }
    if (loggedPairs.has(pairKey(f.fighter1_id, f.fighter2_id))) { out.skipped++; continue; }

    const rounds = roundsFor(f);
    let p;
    try {
      p = await generatePrediction(f.fighter1_id, f.fighter2_id, f.weight_class_id ?? null,
        { scheduledRounds: rounds, skipCache: true, skipNarrative: true });
    } catch (e) {
      console.log(`  ERROR ${label}: ${e.message}`); out.errors++; continue;
    }
    // Guard: a fantasy / snapshot prediction can never be logged (the call above never asks
    // for one, but the log is write-once, so refuse rather than trust the caller).
    if (p.fantasy) { console.log(`  skip ${label}: fantasy prediction`); out.skipped++; continue; }
    const f1Wins = p.fighter1_win_pct >= p.fighter2_win_pct; // exact 50/50 -> fighter1
    const pre = f1Wins ? 'fighter1' : 'fighter2';
    const methods = [['KO/TKO', p[`${pre}_ko_pct`]], ['SUB', p[`${pre}_sub_pct`]], ['DEC', p[`${pre}_dec_pct`]]];
    const method = methods.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    const row = {
      fight_id: f.id, event_id: ev.id, event_name: ev.name, event_date: ev.date,
      fighter1_id: f.fighter1_id, fighter2_id: f.fighter2_id,
      fighter1_name: nameOf[f.fighter1_id], fighter2_name: nameOf[f.fighter2_id],
      weight_class_id: f.weight_class_id ?? null, is_title_fight: !!f.is_title_fight, scheduled_rounds: rounds,
      model_version: p.model_version,
      fighter1_win_pct: p.fighter1_win_pct, fighter2_win_pct: p.fighter2_win_pct,
      fighter1_ko_pct: p.fighter1_ko_pct, fighter1_sub_pct: p.fighter1_sub_pct, fighter1_dec_pct: p.fighter1_dec_pct,
      fighter2_ko_pct: p.fighter2_ko_pct, fighter2_sub_pct: p.fighter2_sub_pct, fighter2_dec_pct: p.fighter2_dec_pct,
      predicted_winner_id: f1Wins ? f.fighter1_id : f.fighter2_id,
      predicted_method: method, confidence: p.confidence,
    };
    const pick = `${f1Wins ? row.fighter1_name : row.fighter2_name} ${Math.max(p.fighter1_win_pct, p.fighter2_win_pct).toFixed(1)}% by ${method}, ${p.confidence}, ${rounds} rds`;
    if (DRY) { console.log(`  [dry] ${label}: ${pick}`); out.logged++; continue; }
    const { error } = await supabase.from('prediction_log').insert(row);
    if (error && error.code === '23505') { console.log(`  skip ${label}: already logged`); out.skipped++; continue; }
    if (error) { console.log(`  ERROR ${label}: ${error.message}`); out.errors++; continue; }
    loggedPairs.add(pairKey(f.fighter1_id, f.fighter2_id));
    console.log(`  logged ${label}: ${pick}`);
    out.logged++;
  }
  return out;
}

async function main() {
  let events;
  if (UPCOMING) {
    const { data, error } = await supabase.from('events').select('id, name, date').gte('date', todayUtc()).order('date');
    if (error) throw new Error(error.message);
    events = data;
  } else {
    const { data, error } = await supabase.from('events').select('id, name, date').in('id', EVENT_IDS);
    if (error) throw new Error(error.message);
    const missing = EVENT_IDS.filter(id => !data.some(e => e.id === id));
    if (missing.length) throw new Error(`event(s) not found: ${missing.join(', ')}`);
    events = data.sort((a, b) => a.date.localeCompare(b.date));
  }
  const total = { logged: 0, skipped: 0, voided: 0, errors: 0 };
  for (const ev of events) {
    const r = await logEvent(ev);
    for (const k of Object.keys(total)) total[k] += r[k];
  }
  console.log(`\nDone${DRY ? ' (dry run)' : ''}: ${total.logged} logged, ${total.skipped} skipped, ${total.voided} voided, ${total.errors} errors`);
  if (total.errors) process.exitCode = 1;
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
