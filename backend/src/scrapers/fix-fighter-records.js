require('dotenv').config();
const supabase = require('../db/client');

const DRY = process.argv.includes('--dry-run');

// Method -> split bucket. Reads stored values only (legacy labels TKO/
// Submission/Decision are exact synonyms). DQ, Overturned, Walkover and
// anything unrecognized count in W/L totals but in no split column.
function splitBucket(method) {
  const U = (method || '').trim().toUpperCase();
  if (U === 'KO/TKO' || U === 'TKO') return 'ko';
  if (U === 'SUB' || U === 'SUBMISSION') return 'sub';
  if (U === 'U-DEC' || U === 'S-DEC' || U === 'M-DEC' || U === 'DEC' || U === 'DECISION') return 'dec';
  return null;
}

async function main() {
  console.log(`Recalculating fighter records from fights table...${DRY ? '  *** DRY RUN ***' : ''}`);

  const records = {};
  const init = () => ({ wins: 0, losses: 0, draws: 0, no_contests: 0,
    wins_ko: 0, wins_sub: 0, wins_dec: 0, losses_ko: 0, losses_sub: 0, losses_dec: 0 });

  let page = 0;
  const PAGE = 1000;
  let total = 0;
  let undecidable = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('fights')
      .select('fighter1_id, fighter2_id, winner_id, result, method')
      .neq('result', 'upcoming')
      .not('result', 'is', null)
      .range(page * PAGE, (page + 1) * PAGE - 1);

    if (error) { console.error(error.message); break; }
    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const { fighter1_id: f1, fighter2_id: f2, winner_id, result, method } = r;
      // A bout with one name-only participant still happened for the KNOWN fighter:
      // count their side and skip only the missing one. Dropping the whole row (the
      // old `if (!f1 || !f2) continue`) left the known fighter's record permanently
      // one short, and disagreed with validate.js, which counts the same row.
      if (!f1 && !f2) continue;
      if (f1 && !records[f1]) records[f1] = init();
      if (f2 && !records[f2]) records[f2] = init();
      const bump = (id, field) => {
        if (!id) return;
        if (!records[id]) records[id] = init();
        records[id][field]++;
      };

      if (result === 'win') {
        // Use winner_id when set (API-Sports fights may have winner as either fighter1 or fighter2).
        // Fall back to fighter1=winner for legacy ufcstats data (winner always listed first) --
        // but only when fighter1 is actually known. With both winner_id and fighter1_id null
        // there is no way to tell who won, so credit nobody rather than guessing.
        const winnerId = winner_id || f1;
        if (!winnerId) { undecidable++; continue; }
        const loserId  = winnerId === f1 ? f2 : f1;
        bump(winnerId, 'wins');
        bump(loserId, 'losses');
        const bucket = splitBucket(method);
        if (bucket) {
          bump(winnerId, 'wins_' + bucket);
          bump(loserId, 'losses_' + bucket);
        }
      } else if (result === 'draw') {
        bump(f1, 'draws');
        bump(f2, 'draws');
      } else if (result === 'no_contest') {
        bump(f1, 'no_contests');
        bump(f2, 'no_contests');
      }
    }

    total += rows.length;
    if (rows.length < PAGE) break;
    page++;
  }

  const fighterIds = Object.keys(records);
  console.log(`  Processed ${total} fight rows`);
  console.log(`  Calculated records for ${fighterIds.length} fighters`);
  if (undecidable) {
    console.log(`  *** ${undecidable} decided bout(s) skipped: result='win' with both winner_id and fighter1_id null — winner unknowable. Run validate.js check 6. ***`);
  }

  const RECORD_COLS = ['wins', 'losses', 'draws', 'no_contests',
    'wins_ko', 'wins_sub', 'wins_dec', 'losses_ko', 'losses_sub', 'losses_dec'];

  if (DRY) {
    // count fighters whose stored values differ from the recalculated ones
    const stored = {};
    let p = 0;
    while (true) {
      const { data, error } = await supabase.from('fighters')
        .select('id, ' + RECORD_COLS.join(', '))
        .range(p * 1000, (p + 1) * 1000 - 1);
      if (error) { console.error(error.message); return; }
      if (!data?.length) break;
      data.forEach(f => { stored[f.id] = f; });
      if (data.length < 1000) break;
      p++;
    }
    let changed = 0, splitOnly = 0;
    for (const id of fighterIds) {
      const s = stored[id];
      if (!s) continue;
      const diffCols = RECORD_COLS.filter(c => (s[c] || 0) !== records[id][c]);
      if (diffCols.length) {
        changed++;
        if (diffCols.every(c => c.includes('_ko') || c.includes('_sub') || c.includes('_dec'))) splitOnly++;
      }
    }
    console.log(`  DRY RUN: ${changed} of ${fighterIds.length} fighter rows would change (${splitOnly} split-columns-only, ${changed - splitOnly} also W/L/D/NC)`);
    console.log('  Nothing written. Re-run without --dry-run to apply.');
    return;
  }

  // Update fighters concurrently in chunks of 50
  const CONCURRENT = 50;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < fighterIds.length; i += CONCURRENT) {
    const chunk = fighterIds.slice(i, i + CONCURRENT);
    await Promise.all(chunk.map(async id => {
      const rec = records[id];
      const payload = {};
      RECORD_COLS.forEach(c => { payload[c] = rec[c]; });
      const { error } = await supabase
        .from('fighters')
        .update(payload)
        .eq('id', id);
      if (error) { errors++; }
      else updated++;
    }));

    if ((i + CONCURRENT) % 500 === 0) {
      process.stdout.write(`\r  ${updated}/${fighterIds.length} updated...`);
    }
  }

  console.log(`\nDone -- ${updated} updated, ${errors} errors`);
}

main().catch(console.error);
