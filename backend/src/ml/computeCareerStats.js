/**
 * computeCareerStats.js — write real career stats to the fighters table,
 * computed from fights.rounds_data via statsEngine (replaces the stale
 * 2025-era seed values in slpm/sapm/str_acc/... and finally populates
 * cardio_output_r1-5 / cardio_degradation / late_finish_rate / etc).
 *
 * New columns (kd_per15, ctrl_pct, style mix, stats_fight_count, recent_form)
 * require src/db/migrations/2026-07-06-add-computed-stats.sql — run it in the
 * Supabase SQL editor first. Without it the script still updates the columns
 * that exist and says what it skipped.
 *
 * DEFAULT = DRY RUN (prints, writes nothing). Pass --apply to write.
 * Flags: --apply · --fighter "name substr" (repeatable via comma) · --limit N
 *
 * Run: node -r dotenv/config src/ml/computeCareerStats.js --fighter "holloway,jon jones"
 */
require('dotenv').config();
const supabase = require('../db/client');
const { buildTimelines, snapshot } = require('./statsEngine');

const APPLY = process.argv.includes('--apply');
const FILTER = (() => { const i = process.argv.indexOf('--fighter'); return i > -1 ? process.argv[i + 1].toLowerCase().split(',').map(s => s.trim()) : null; })();
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1]) : Infinity; })();

async function loadAll(table, cols) {
  const all = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`loadAll(${table}): ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

// which optional columns exist? (migration may not be applied yet)
async function detectNewColumns() {
  const probe = await supabase.from('fighters').select('kd_per15, recent_form').limit(1);
  return !probe.error;
}

// Columns are NUMERIC(5,2) (max ±999.99). Degenerate fights (seconds-long,
// near-zero R1 output) can produce legitimate but unstorable values like a
// -2000% degradation — clamp at write time, keep the engine's math untouched.
const clamp = v => (v == null ? null : Math.max(-999.99, Math.min(999.99, v)));

const compactForm = s => s && s.stats_fights > 0 ? {
  fights: s.stats_fights, wins: Math.round((s.stats_win_rate || 0) / 100 * s.stats_fights),
  slpm: s.slpm, sapm: s.sapm, str_acc: s.str_acc, str_def: s.str_def,
  td_avg: s.td_avg, td_def: s.td_def, ctrl_pct: s.ctrl_pct, kd_per15: s.kd_per15,
} : null;

function printSnapshot(name, s) {
  console.log(`\n════ ${name} ════`);
  console.log(`  record (completed fights in DB): ${s.record.wins}-${s.record.losses}-${s.record.draws}${s.record.nc ? ` (${s.record.nc} NC)` : ''}  |  stats fights: ${s.stats_fights}/${s.total_fights}  |  cage time: ${(s.stats_seconds / 60).toFixed(1)} min`);
  console.log(`  striking:  SLpM ${s.slpm}  SApM ${s.sapm}  acc ${s.str_acc}%  def ${s.str_def}%  KD/15 ${s.kd_per15}  KD absorbed/15 ${s.kd_absorbed_per15}`);
  console.log(`  grappling: TD ${s.td_avg}/15min  acc ${s.td_acc}%  def ${s.td_def}%  subs ${s.sub_avg}/15min  ctrl ${s.ctrl_pct}%`);
  console.log(`  style mix: distance ${s.sig_distance_pct}%  clinch ${s.sig_clinch_pct}%  ground ${s.sig_ground_pct}%`);
  console.log(`  cardio (sig att/min by round): R1 ${s.cardio.r1}  R2 ${s.cardio.r2}  R3 ${s.cardio.r3}  R4 ${s.cardio.r4}  R5 ${s.cardio.r5}  |  degradation R1->R3: ${s.cardio_degradation}%`);
  console.log(`  timing:    late finish rate ${s.late_finish_rate}%  late loss rate ${s.late_loss_rate}%  champ rounds ${s.championship_round_record || 'n/a'}`);
}

async function main() {
  console.log(`Career stats from rounds_data ${APPLY ? '*** APPLY ***' : '*** DRY RUN ***'}\n`);

  const events = await loadAll('events', 'id, date');
  const fights = await loadAll('fights',
    'id, event_id, fighter1_id, fighter2_id, winner_id, result, method, round, time, time_format, is_title_fight, rounds_data');
  const fighters = await loadAll('fighters', 'id, first_name, last_name');
  console.log(`Loaded ${fights.length} fights, ${fighters.length} fighters`);

  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  const timelines = buildTimelines(fights, eventById);
  console.log(`Timelines built for ${timelines.size} fighters with completed fights\n`);

  const hasNewCols = await detectNewColumns();
  if (!hasNewCols) console.log('NOTE: new columns missing (run 2026-07-06-add-computed-stats.sql) — kd/ctrl/style/recent_form will be SKIPPED\n');

  let targets = fighters.filter(f => timelines.has(f.id));
  if (FILTER) targets = targets.filter(f =>
    FILTER.some(q => `${f.first_name} ${f.last_name}`.toLowerCase().includes(q)));
  targets = targets.slice(0, LIMIT);
  console.log(`Fighters to compute: ${targets.length}`);

  let updated = 0, skippedNoStats = 0, errors = 0;
  for (const f of targets) {
    const tl = timelines.get(f.id);
    const s = snapshot(tl);
    const name = `${f.first_name} ${f.last_name}`;

    if (FILTER) printSnapshot(name, s);
    if (s.stats_fights === 0) { skippedNoStats++; continue; }

    const patch = {
      slpm: clamp(s.slpm), sapm: clamp(s.sapm), str_acc: clamp(s.str_acc), str_def: clamp(s.str_def),
      td_avg: clamp(s.td_avg), td_acc: clamp(s.td_acc), td_def: clamp(s.td_def), sub_avg: clamp(s.sub_avg),
      cardio_output_r1: clamp(s.cardio.r1), cardio_output_r2: clamp(s.cardio.r2), cardio_output_r3: clamp(s.cardio.r3),
      cardio_output_r4: clamp(s.cardio.r4), cardio_output_r5: clamp(s.cardio.r5),
      cardio_degradation: clamp(s.cardio_degradation),
      late_finish_rate: clamp(s.late_finish_rate), late_loss_rate: clamp(s.late_loss_rate),
      championship_round_record: s.championship_round_record,
    };
    if (hasNewCols) {
      Object.assign(patch, {
        kd_per15: clamp(s.kd_per15), kd_absorbed_per15: clamp(s.kd_absorbed_per15), ctrl_pct: clamp(s.ctrl_pct),
        sig_distance_pct: clamp(s.sig_distance_pct), sig_clinch_pct: clamp(s.sig_clinch_pct), sig_ground_pct: clamp(s.sig_ground_pct),
        stats_fight_count: s.stats_fights, stats_total_seconds: s.stats_seconds,
        recent_form: { last3: compactForm(snapshot(tl, null, 3)), last5: compactForm(snapshot(tl, null, 5)) },
      });
    }

    if (APPLY) {
      const { error } = await supabase.from('fighters').update(patch).eq('id', f.id);
      if (error) { errors++; console.error(`  ERR ${name}: ${error.message}`); continue; }
    }
    updated++;
    if (APPLY && updated % 250 === 0) console.log(`  ...${updated}/${targets.length}`);
  }

  console.log(`\n${APPLY ? 'Updated' : 'Would update'}: ${updated}  |  no stats fights (untouched): ${skippedNoStats}  |  errors: ${errors}`);
  if (!APPLY) console.log('DRY RUN — nothing written. Re-run with --apply to write.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
