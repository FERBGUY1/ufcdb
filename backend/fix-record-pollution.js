/**
 * ITEM 4 / H2 FIX — career records polluting UFC wins/losses fields on zero-fight fighters.
 *
 * MOVE-NOT-DELETE: the seed wrote each fighter's lifetime/pro record into the UFC
 * record block. For fighters with 0 rows in `fights`, that whole block is fake.
 * We zero the UFC block, but only AFTER guaranteeing the real number survives in
 * career_* (and/or pro_*). pro_* is authoritative and left untouched.
 *
 * Rule per polluted fighter:
 *   1. If the career_* block is empty (all four = 0), copy the UFC block into it.
 *      (If career_* already holds a record, leave it — don't overwrite.)
 *   2. Zero the UFC block: wins, losses, draws, no_contests + the six method splits
 *      (wins_ko/sub/dec, losses_ko/sub/dec).
 *   3. pro_* untouched.
 *
 * Reversible: once a fighter's real fights are imported, fix-fighter-records.js
 * recomputes wins/losses/draws/no_contests from the fights table, rebuilding the
 * UFC block from scratch. Zeroing here only removes a value that was never real.
 *
 * DEFAULT = DRY RUN. Pass --apply to write. NO WRITES happen without --apply.
 */
require('dotenv').config();
const s = require('./src/db/client');

const APPLY = process.argv.includes('--apply');

async function loadAll(table, cols) {
  const all = []; let p = 0;
  while (true) {
    const { data, error } = await s.from(table).select(cols).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    p++;
  }
  return all;
}

const ufcTot  = f => (f.wins||0)+(f.losses||0)+(f.draws||0)+(f.no_contests||0);
const proTot  = f => f.pro_wins==null ? null : (f.pro_wins||0)+(f.pro_losses||0)+(f.pro_draws||0)+(f.pro_nc||0);
const name    = f => `${f.first_name} ${f.last_name}`;

async function main() {
  const fights = await loadAll('fights', 'fighter1_id, fighter2_id');
  const hasFights = new Set();
  fights.forEach(f => { if (f.fighter1_id) hasFights.add(f.fighter1_id); if (f.fighter2_id) hasFights.add(f.fighter2_id); });

  const fighters = await loadAll('fighters',
    'id, first_name, last_name, ufc_id, sherdog_id, status, is_champion, ' +
    'wins, losses, draws, no_contests, wins_ko, wins_sub, wins_dec, losses_ko, losses_sub, losses_dec, ' +
    'career_wins, career_losses, career_draws, career_no_contests, pro_wins, pro_losses, pro_draws, pro_nc');

  const polluted = fighters.filter(f => !hasFights.has(f.id) && ufcTot(f) > 0);

  console.log(`MODE: ${APPLY ? '*** APPLY (writing) ***' : 'DRY RUN (no writes)'}`);
  console.log(`Polluted set (0 fight rows AND non-zero UFC record): ${polluted.length}\n`);

  // ── Build update plan ────────────────────────────────────────────────────
  let moveToCareer = 0, careerAlreadySet = 0, lossViolations = [], updates = [];
  for (const f of polluted) {
    const careerEmpty = (f.career_wins||0)===0 && (f.career_losses||0)===0 && (f.career_draws||0)===0 && (f.career_no_contests||0)===0;
    const patch = { wins:0, losses:0, draws:0, no_contests:0, wins_ko:0, wins_sub:0, wins_dec:0, losses_ko:0, losses_sub:0, losses_dec:0 };
    if (careerEmpty) {
      patch.career_wins = f.wins||0; patch.career_losses = f.losses||0;
      patch.career_draws = f.draws||0; patch.career_no_contests = f.no_contests||0;
      moveToCareer++;
    } else {
      careerAlreadySet++;
    }
    // NO-DATA-LOSS INVARIANT: for each UFC field being zeroed, the value must
    // survive in career_* (after patch) OR in pro_* (authoritative).
    const careerAfterW  = patch.career_wins  ?? (f.career_wins||0);
    const careerAfterL  = patch.career_losses?? (f.career_losses||0);
    const survivesW = careerAfterW >= (f.wins||0)   || (f.pro_wins!=null   && f.pro_wins   >= (f.wins||0));
    const survivesL = careerAfterL >= (f.losses||0) || (f.pro_losses!=null && f.pro_losses >= (f.losses||0));
    if (!survivesW || !survivesL) lossViolations.push(f);
    updates.push({ id: f.id, patch });
  }

  console.log('======== UPDATE PLAN ========');
  console.log(`  Fighters to update:                       ${updates.length}`);
  console.log(`  ...career_* EMPTY -> move UFC into career: ${moveToCareer}`);
  console.log(`  ...career_* already populated -> just zero:${careerAlreadySet}`);
  console.log(`  NO-DATA-LOSS invariant violations:         ${lossViolations.length}  (must be 0)`);
  if (lossViolations.length) {
    console.log('  !! these would lose a record — NOT safe to zero:');
    lossViolations.slice(0,30).forEach(f => console.log(`     ${name(f)} UFC=${f.wins}-${f.losses} career=${f.career_wins}-${f.career_losses} pro=${f.pro_wins}-${f.pro_losses}`));
  }

  // ── Safety: not-homogeneous (real UFC identities in the set) ──────────────
  const withUfcId = polluted.filter(f => f.ufc_id);
  const champs    = polluted.filter(f => f.is_champion);
  const ufcGtPro  = polluted.filter(f => { const p = proTot(f); return p!=null && ufcTot(f) > p; });
  const winsGtPro = polluted.filter(f => f.pro_wins!=null && (f.wins||0) > f.pro_wins);
  console.log('\n======== SAFETY CHECKS ========');
  console.log(`  flagged is_champion:                  ${champs.length}  (expect 0)`);
  console.log(`  UFC total EXCEEDS pro total:          ${ufcGtPro.length}  (expect 0 — would mean a real sub-record)`);
  console.log(`  UFC wins EXCEED pro_wins:             ${winsGtPro.length}  (expect 0)`);
  console.log(`  carry a ufc_id (note, not a blocker): ${withUfcId.length}  (event-id pollution, see item-6 finding)`);
  if (champs.length) champs.forEach(f => console.log(`     CHAMP: ${name(f)} UFC=${f.wins}-${f.losses}`));
  if (ufcGtPro.length) ufcGtPro.slice(0,20).forEach(f => console.log(`     UFC>pro: ${name(f)} UFC=${ufcTot(f)} pro=${proTot(f)}`));

  // ── The 538: UFC < pro (the only theoretically-ambiguous group) ───────────
  const ufcLtPro = polluted
    .filter(f => { const p = proTot(f); return p!=null && ufcTot(f) < p; })
    .sort((a,b) => ufcTot(b)-ufcTot(a));
  console.log(`\n======== UFC < PRO LIST (${ufcLtPro.length}) — EYEBALL BEFORE ZEROING ========`);
  console.log('  name | UFC(w-l-d-nc) | pro(w-l-d-nc) | career(w-l-d-nc) | ufc_id? | status');
  ufcLtPro.forEach(f => {
    console.log(`  ${name(f)} | UFC ${f.wins}-${f.losses}-${f.draws}-${f.no_contests} | pro ${f.pro_wins}-${f.pro_losses}-${f.pro_draws}-${f.pro_nc} | career ${f.career_wins}-${f.career_losses}-${f.career_draws}-${f.career_no_contests} | ${f.ufc_id?'ufc_id':'—'} | ${f.status}`);
  });

  // ── Before/after examples ─────────────────────────────────────────────────
  console.log('\n======== BEFORE/AFTER EXAMPLES (largest fake UFC records) ========');
  const big = [...polluted].sort((a,b)=>ufcTot(b)-ufcTot(a)).slice(0,8);
  for (const f of big) {
    const u = updates.find(x=>x.id===f.id).patch;
    const cW = u.career_wins ?? f.career_wins, cL = u.career_losses ?? f.career_losses,
          cD = u.career_draws ?? f.career_draws, cN = u.career_no_contests ?? f.career_no_contests;
    console.log(`  ${name(f)} (ufc_id=${f.ufc_id||'none'})`);
    console.log(`     BEFORE: UFC ${f.wins}-${f.losses}-${f.draws}-${f.no_contests} | career ${f.career_wins}-${f.career_losses}-${f.career_draws}-${f.career_no_contests} | pro ${f.pro_wins ?? 'null'}-${f.pro_losses ?? 'null'}`);
    console.log(`     AFTER : UFC 0-0-0-0 | career ${cW}-${cL}-${cD}-${cN}${u.career_wins!=null?'  <-moved':''} | pro ${f.pro_wins ?? 'null'}-${f.pro_losses ?? 'null'} (untouched)`);
  }

  // ── 248 recover-via-sherdog (separate item 6) ─────────────────────────────
  const noPro = polluted.filter(f => f.pro_wins == null);
  console.log(`\n  Polluted with pro_wins IS NULL (item-6 sherdog re-run target): ${noPro.length}`);

  // ── APPLY ─────────────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log('\nDRY RUN — no writes. Re-run with --apply to commit.');
    return;
  }
  if (lossViolations.length) { console.error('\nABORT: data-loss invariant violated; refusing to write.'); process.exit(1); }
  console.log('\nApplying updates...');
  let ok = 0, errs = 0;
  for (const { id, patch } of updates) {
    const { error } = await s.from('fighters').update(patch).eq('id', id);
    if (error) { errs++; console.error(`  ERR ${id}: ${error.message}`); } else ok++;
  }
  console.log(`Done. updated=${ok} errors=${errs}`);
  console.log('NEXT: run fix-fighter-records.js, then validate.js.');
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
