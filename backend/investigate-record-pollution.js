/**
 * READ-ONLY investigation of H2 — career records polluting UFC wins/losses fields
 * for zero-fight fighters. NO WRITES.
 */
require('dotenv').config();
const s = require('./src/db/client');

async function loadAll(table, cols) {
  const all=[]; let p=0;
  while(true){const{data,error}=await s.from(table).select(cols).range(p*1000,p*1000+999);if(error)throw new Error(error.message);if(!data?.length)break;all.push(...data);if(data.length<1000)break;p++;}
  return all;
}

async function main() {
  // who has fight rows?
  const fights = await loadAll('fights', 'fighter1_id, fighter2_id');
  const hasFights = new Set();
  fights.forEach(f => { if(f.fighter1_id) hasFights.add(f.fighter1_id); if(f.fighter2_id) hasFights.add(f.fighter2_id); });

  const fighters = await loadAll('fighters',
    'id, first_name, last_name, ufc_id, sherdog_id, status, is_champion, wins, losses, draws, no_contests, career_wins, career_losses, career_draws, career_no_contests, pro_wins, pro_losses, pro_draws, pro_nc');

  const ufcTot = f => (f.wins||0)+(f.losses||0)+(f.draws||0)+(f.no_contests||0);

  // ── 1. The set ───────────────────────────────────────────────────────────
  const zeroFight = fighters.filter(f => !hasFights.has(f.id));
  const polluted = zeroFight.filter(f => ufcTot(f) > 0);
  console.log('======== 1. COUNT & IDENTIFICATION ========');
  console.log(`Total fighters:                              ${fighters.length}`);
  console.log(`Fighters with 0 rows in fights table:        ${zeroFight.length}`);
  console.log(`  ...AND non-zero UFC wins/losses/draws/nc:  ${polluted.length}   <-- the H2 set`);
  console.log(`  ...with 0 fights AND all-zero UFC fields:   ${zeroFight.length - polluted.length} (clean, not in scope)`);

  // ── 2. Are UFC fields actually career/pro totals? ────────────────────────
  console.log('\n======== 2. WHERE DID THE VALUES COME FROM? ========');
  const eqCareer = polluted.filter(f => (f.career_wins||0)===(f.wins||0) && (f.career_losses||0)===(f.losses||0) && (f.career_wins||0)+(f.career_losses||0) > 0);
  const eqPro    = polluted.filter(f => f.pro_wins!=null && f.pro_wins===(f.wins||0) && f.pro_losses===(f.losses||0));
  const careerEmpty = polluted.filter(f => (f.career_wins||0)===0 && (f.career_losses||0)===0);
  console.log(`  UFC wins/losses == career_wins/career_losses (career copied into UFC fields): ${eqCareer.length}`);
  console.log(`  UFC wins/losses == pro_wins/pro_losses (pro record sitting in UFC fields):    ${eqPro.length}`);
  console.log(`  H2 fighters whose career_* is EMPTY (real record only survives in UFC fields): ${careerEmpty.length}`);
  console.log(`     ^ for these, a blind zero would LOSE the record unless moved to career_* / pro_* first`);

  // ── 5. Not-homogeneous risk: any real UFC fighters in the set? ───────────
  console.log('\n======== 5. NOT-HOMOGENEOUS RISK (real UFC fighters in the set) ========');
  const withUfcId = polluted.filter(f => f.ufc_id);
  const champs = polluted.filter(f => f.is_champion);
  console.log(`  H2 fighters WITH a ufc_id (ufcstats profile => fought in UFC, fights MISSING): ${withUfcId.length}`);
  console.log(`  H2 fighters flagged is_champion: ${champs.length}`);
  if (withUfcId.length) {
    console.log('  --- ufc_id-bearing (review before any zero) ---');
    withUfcId.slice(0, 40).forEach(f => console.log(`     ${f.first_name} ${f.last_name}  ufc_id=${f.ufc_id}  UFC=${f.wins}-${f.losses}-${f.draws} career=${f.career_wins}-${f.career_losses} pro=${f.pro_wins}-${f.pro_losses} status=${f.status}`));
    if (withUfcId.length>40) console.log(`     ... and ${withUfcId.length-40} more`);
  }
  if (champs.length) champs.forEach(f => console.log(`     CHAMP: ${f.first_name} ${f.last_name} UFC=${f.wins}-${f.losses}`));

  // ── 4. Before/after examples ─────────────────────────────────────────────
  console.log('\n======== 4. BEFORE/AFTER EXAMPLES ========');
  const big = [...polluted].sort((a,b)=>ufcTot(b)-ufcTot(a)).slice(0,10);
  console.log('  (largest fake "UFC" records — clearest contamination)');
  for (const f of big) {
    console.log(`  ${f.first_name} ${f.last_name} (ufc_id=${f.ufc_id||'none'})`);
    console.log(`     NOW : UFC ${f.wins}-${f.losses}-${f.draws} (${f.no_contests}NC) | career ${f.career_wins}-${f.career_losses}-${f.career_draws} | pro ${f.pro_wins ?? 'null'}-${f.pro_losses ?? 'null'}`);
    const tgtCareerW = (f.career_wins||0) || f.wins, tgtCareerL = (f.career_losses||0) || f.losses;
    console.log(`     WANT: UFC 0-0-0 (0NC) | career ${tgtCareerW}-${tgtCareerL}${(f.career_wins||0)===0?' (move from UFC fields)':''} | pro ${f.pro_wins ?? 'null'}-${f.pro_losses ?? 'null'}`);
  }

  // ── 3. Sherdog guard impact ──────────────────────────────────────────────
  console.log('\n======== 3. SHERDOG-GUARD IMPACT ========');
  const unscrapedPolluted = polluted.filter(f => f.pro_wins == null);
  console.log(`  H2 fighters still missing a pro record (pro_wins IS NULL): ${unscrapedPolluted.length}`);
  console.log('  Guard rule: SKIP if pro_total < ufc_total || pro_wins < wins || pro_losses < losses.');
  console.log('  With career totals in the UFC fields, the correct Sherdog profile (true pro record)');
  console.log('  often has equal-or-smaller counts than the inflated UFC field -> guard SKIPS it.');

  // ── 6. consumers ─────────────────────────────────────────────────────────
  console.log('\n======== 6. WHAT READS THESE FIELDS ========');
  console.log('  (no FK constraints — plain integer columns)');
  console.log('  - FighterPage.jsx: hero record uses pro_* if present else f.wins/f.losses;');
  console.log('    "UFC record" line always shows f.wins-f.losses; career_* shown as fallback line.');
  console.log('  - routes/fighters.js, search.js, rankings.js, styles.js return/sort on these.');
  console.log('  => zeroing UFC fields is display-safe ONLY where pro_* or career_* still holds the real record.');
}
main().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
