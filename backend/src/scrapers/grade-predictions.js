/**
 * grade-predictions.js — fill the grading columns of prediction_log once an
 * event is complete (run by `npm run weekly`; safe to run any time).
 *
 * Each ungraded row is matched to the event's fight by the unordered fighter
 * pair (not fight_id: the fights row may have been re-created by a card sync).
 *   win             -> outcome 'graded', correct = (winner == predicted winner)
 *   draw / NC       -> outcome 'void', void_reason 'draw' | 'no_contest'
 *   pair not found  -> outcome 'void', 'matchup_changed' (a fighter is still on
 *                      the card) or 'cancelled'
 * Rows on events that are not is_complete yet are left alone and reported.
 * The database only lets each grading column be written once, from NULL.
 *
 * Flags: --dry-run
 * Run: node -r dotenv/config src/scrapers/grade-predictions.js [--dry-run]
 */
require('dotenv').config();
const supabase = require('../db/client');

const DRY = process.argv.includes('--dry-run');
const pairKey = (a, b) => [a, b].sort().join('|');

async function main() {
  const rows = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase.from('prediction_log')
      .select('id, event_id, event_name, event_date, fighter1_id, fighter2_id, fighter1_name, fighter2_name, predicted_winner_id')
      .is('graded_at', null).order('event_date').range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`prediction_log: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const byEvent = new Map();
  rows.forEach(r => { if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []); byEvent.get(r.event_id).push(r); });

  let correct = 0, wrong = 0, voided = 0, pending = 0, errors = 0;
  for (const [eventId, picks] of byEvent) {
    const { data: ev } = await supabase.from('events').select('name, date, is_complete').eq('id', eventId).maybeSingle();
    if (!ev || !ev.is_complete) {
      pending += picks.length;
      console.log(`${picks[0].event_name} (${picks[0].event_date}): ${picks.length} picks pending — event ${ev ? 'not complete yet' : 'row missing'}`);
      continue;
    }
    const { data: fights, error: fe } = await supabase.from('fights')
      .select('fighter1_id, fighter2_id, winner_id, result, method, round, time').eq('event_id', eventId);
    if (fe) throw new Error(`fights: ${fe.message}`);
    const fightByPair = new Map(fights.filter(f => f.fighter1_id && f.fighter2_id).map(f => [pairKey(f.fighter1_id, f.fighter2_id), f]));
    const booked = new Set(fights.flatMap(f => [f.fighter1_id, f.fighter2_id]).filter(Boolean));

    let line = { correct: 0, wrong: 0, voided: 0, skipped: 0 };
    for (const r of picks) {
      const f = fightByPair.get(pairKey(r.fighter1_id, r.fighter2_id));
      let patch;
      if (!f) {
        const reason = booked.has(r.fighter1_id) || booked.has(r.fighter2_id) ? 'matchup_changed' : 'cancelled';
        patch = { outcome: 'void', void_reason: reason };
      } else if (f.result === 'win' && f.winner_id) {
        patch = { outcome: 'graded', correct: f.winner_id === r.predicted_winner_id, actual_winner_id: f.winner_id };
      } else if (f.result === 'draw' || f.result === 'no_contest') {
        patch = { outcome: 'void', void_reason: f.result };
      } else {
        console.log(`  ${r.fighter1_name} vs ${r.fighter2_name}: result=${f.result} on a complete event — left ungraded`);
        line.skipped++; continue;
      }
      if (f) Object.assign(patch, { actual_result: f.result, actual_method: f.method, actual_round: f.round, actual_time: f.time });
      patch.graded_at = new Date().toISOString();
      if (!DRY) {
        const { error } = await supabase.from('prediction_log').update(patch).eq('id', r.id).is('graded_at', null);
        if (error) { console.log(`  ERROR ${r.fighter1_name} vs ${r.fighter2_name}: ${error.message}`); errors++; continue; }
      }
      if (patch.outcome === 'void') line.voided++;
      else if (patch.correct) line.correct++;
      else line.wrong++;
    }
    correct += line.correct; wrong += line.wrong; voided += line.voided; pending += line.skipped;
    console.log(`${ev.name} (${ev.date}): ${line.correct}/${line.correct + line.wrong} correct, ${line.voided} void${line.skipped ? `, ${line.skipped} left ungraded` : ''}`);
  }
  console.log(`\nDone${DRY ? ' (dry run)' : ''}: ${correct + wrong} graded (${correct} correct, ${wrong} wrong), ${voided} void, ${pending} pending, ${errors} errors`);
  if (errors) process.exitCode = 1;
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
