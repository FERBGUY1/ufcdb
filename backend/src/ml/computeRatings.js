/**
 * Compute contextual performance ratings for all fighters.
 *
 * DEFAULT = DRY RUN (prints a plan + distributions, writes nothing).
 * Pass --apply to write.
 *
 * Flags:
 *   --apply                write; without it the script only reports
 *   --ids "uuid,uuid,..."  restrict to specific fighter ids (e.g. one event's
 *                          card) instead of the default all-fighters sweep.
 *                          Keep batches <= 100 ids — .in() URLs get too long.
 *   --with-fights          skip fighters with no fight history (their ratings
 *                          are computed from null stats and mean nothing);
 *                          also avoids a resume-strength query per empty row.
 *   --sample "name,name"   extra fighters to show before/after rows for
 *
 * Run: node -r dotenv/config src/ml/computeRatings.js --apply
 */
require('dotenv').config();
const supabase = require('../db/client');
const { computeResumeStrength, detectCareerArc } = require('./qualityEngine');

const APPLY = process.argv.includes('--apply');
const WITH_FIGHTS = process.argv.includes('--with-fights');
const IDS = (() => {
  const i = process.argv.indexOf('--ids');
  return i > -1 ? process.argv[i + 1].split(',').map(s => s.trim()).filter(Boolean) : null;
})();
const SAMPLE = (() => {
  const i = process.argv.indexOf('--sample');
  return i > -1 ? process.argv[i + 1].toLowerCase().split(',').map(s => s.trim()).filter(Boolean) : [];
})();

// str_acc / td_acc are real columns on fighters and are read by the rating
// math below — omitting them from this list silently fed the || 50 fallback
// into every striking and wrestling rating.
const COLS = [
  'id', 'first_name', 'last_name', 'wins', 'losses',
  'slpm', 'sapm', 'str_acc', 'td_avg', 'td_acc', 'td_def',
  'wins_ko', 'wins_sub', 'stats_fight_count',
  'rating_striking', 'rating_wrestling', 'rating_grappling',
  'rating_cardio', 'rating_overall', 'resume_strength_score',
].join(', ');

// Supabase returns at most 1000 rows per request; .limit(2000) does not lift
// that cap, it just silently truncates. Page with .range() instead.
async function loadFighters() {
  if (IDS) {
    const all = [];
    for (let i = 0; i < IDS.length; i += 100) {
      const { data, error } = await supabase.from('fighters').select(COLS).in('id', IDS.slice(i, i + 100));
      if (error) throw new Error(`loadFighters(ids): ${error.message}`);
      all.push(...(data || []));
    }
    return all;
  }
  const all = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase.from('fighters').select(COLS)
      .order('id').range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`loadFighters(page ${page}): ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

function ratingsFor(f) {
  const ratingStriking  = Math.min(10, Math.max(1, (f.slpm || 0) * 0.8 + (f.str_acc || 50) / 100 * 3));
  const ratingWrestling = Math.min(10, Math.max(1, (f.td_avg || 0) * 1.5 + (f.td_acc || 50) / 100 * 2));
  const ratingGrappling = Math.min(10, Math.max(1, ((f.wins_sub || 0) / Math.max(f.wins, 1)) * 10));
  const ratingCardio    = Math.min(10, Math.max(1, 5 + (f.wins - f.losses > 0 ? 1 : -1)));
  const ratingOverall   = (ratingStriking + ratingWrestling + ratingGrappling + ratingCardio) / 4;
  return { ratingStriking, ratingWrestling, ratingGrappling, ratingCardio, ratingOverall };
}

const name = f => `${f.first_name} ${f.last_name}`;
const num = v => (v === null || v === undefined ? 'null' : Number(v).toFixed(2));

function dist(values) {
  const v = values.slice().sort((a, b) => a - b);
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return { min: v[0], median, max: v[v.length - 1], n: v.length };
}

function showRow(f, r) {
  console.log(`  ${name(f).padEnd(24)} ${String(f.wins + '-' + f.losses).padEnd(7)} sfc=${String(f.stats_fight_count ?? '-').padEnd(3)}` +
    ` str_acc=${String(f.str_acc ?? 'null').padEnd(6)} td_acc=${String(f.td_acc ?? 'null').padEnd(6)}`);
  console.log(`    overall   ${num(f.rating_overall).padStart(6)} -> ${r.ratingOverall.toFixed(2).padStart(6)}` +
    `    striking ${num(f.rating_striking).padStart(6)} -> ${r.ratingStriking.toFixed(2).padStart(6)}` +
    `    wrestling ${num(f.rating_wrestling).padStart(6)} -> ${r.ratingWrestling.toFixed(2).padStart(6)}`);
}

async function main() {
  console.log(`Computing fighter ratings...  ${APPLY ? '*** APPLY ***' : '*** DRY RUN — nothing written ***'}${IDS ? `  (scoped to ${IDS.length} ids)` : ''}`);

  const loaded = await loadFighters();
  const hasHistory = f => (f.stats_fight_count || 0) > 0 || (f.wins + f.losses) > 0;
  const withFights = loaded.filter(hasHistory);
  console.log(`\n  fighters loaded: ${loaded.length}   (with fight history: ${withFights.length})`);

  const fighters = WITH_FIGHTS ? withFights : loaded;
  if (WITH_FIGHTS) console.log(`  --with-fights: scoped to ${fighters.length}, skipping ${loaded.length - fighters.length} with no fight history`);

  const computed = fighters.map(f => ({ f, r: ratingsFor(f) }));

  if (!APPLY) {
    const striking  = dist(computed.map(c => c.r.ratingStriking));
    const wrestling = dist(computed.map(c => c.r.ratingWrestling));
    const fellBack  = fighters.filter(f => f.str_acc === null || f.str_acc === undefined).length;
    const fellBackTd = fighters.filter(f => f.td_acc === null || f.td_acc === undefined).length;

    console.log('\n━━━━ SAMPLE ROWS (before -> after) ━━━━');
    const picks = [];
    const byName = s => computed.find(c => name(c.f).toLowerCase() === s);
    for (const s of ['joshua van', 'alexandre pantoja', ...SAMPLE]) {
      const hit = byName(s); if (hit) picks.push(hit);
    }
    const vets = computed.filter(c => (c.f.stats_fight_count || 0) >= 12 && !picks.includes(c));
    for (let i = 0; i < 3 && vets.length; i++) picks.push(vets.splice(Math.floor(Math.random() * vets.length), 1)[0]);
    picks.forEach(p => showRow(p.f, p.r));

    console.log('\n━━━━ DISTRIBUTIONS (computed, all loaded fighters) ━━━━');
    console.log(`  rating_striking    min ${striking.min.toFixed(2)}   median ${striking.median.toFixed(2)}   max ${striking.max.toFixed(2)}   n=${striking.n}`);
    console.log(`  rating_wrestling   min ${wrestling.min.toFixed(2)}   median ${wrestling.median.toFixed(2)}   max ${wrestling.max.toFixed(2)}   n=${wrestling.n}`);
    console.log(`\n  rows still hitting the 50 fallback: str_acc null on ${fellBack}, td_acc null on ${fellBackTd}`);
    console.log('\nDry run complete — nothing written. Re-run with --apply to execute.');
    return;
  }

  let updated = 0, errors = 0;
  for (const { f, r } of computed) {
    const resumeScore = await computeResumeStrength(f.id);
    const { error } = await supabase.from('fighters').update({
      rating_striking: r.ratingStriking.toFixed(2),
      rating_wrestling: r.ratingWrestling.toFixed(2),
      rating_grappling: r.ratingGrappling.toFixed(2),
      rating_cardio: r.ratingCardio.toFixed(2),
      rating_overall: r.ratingOverall.toFixed(2),
      resume_strength_score: resumeScore.toFixed(2),
    }).eq('id', f.id);
    if (error) { errors++; if (errors <= 5) console.warn(`  ERROR ${name(f)}: ${error.message}`); }
    else updated++;
    if (updated % 500 === 0 && updated) console.log(`  ...${updated}/${computed.length}`);
  }
  console.log(`\n✓ Updated ratings for ${updated} fighters  |  errors: ${errors}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
