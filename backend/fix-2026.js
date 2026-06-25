/**
 * fix-2026.js — manual corrections that audit-2026.js cannot apply automatically.
 *
 * Covers:
 *   1. Justin Tafa identity fix — fights credited to wrong "Justin" vs correct "Junior"
 *   2. Method=fighter-name bug — "Mitchell" and "Schnell" stored as method strings
 *
 * Run AFTER: node -r dotenv/config src/scrapers/audit-2026.js --fix --no-fix-winners
 * Then run:  node -r dotenv/config src/scrapers/fix-fighter-records.js
 */
require('dotenv').config();
const supabase = require('./src/db/client');

function norm(s) {
  return (s || '').toLowerCase()
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function patch(id, fields, label) {
  const { error } = await supabase.from('fights').update(fields).eq('id', id);
  if (error) console.error(`  ERR ${id.slice(0,8)} ${label}: ${error.message}`);
  else        console.log( `  OK  ${id.slice(0,8)} ${label}`);
}

async function main() {
  // ── Load fighter lookup ───────────────────────────────────────────────────────
  let allFighters = [];
  let page = 0;
  while (true) {
    const { data } = await supabase.from('fighters').select('id,first_name,last_name')
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data?.length) break;
    allFighters.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  const byName = {};
  allFighters.forEach(f => {
    byName[norm((f.first_name || '') + (f.last_name || ''))] = f;
  });
  const fById = Object.fromEntries(allFighters.map(f => [f.id, f]));
  const fname = id => { const f = fById[id]; return f ? `${f.first_name} ${f.last_name}` : id?.slice(0,8); };

  // ── 0. Swap fighter1 / fighter2 for 2026 fights where winner_id = fighter2_id ─
  // Convention: fighter1_id MUST be the winner. These 4 fights have the right winner
  // recorded in winner_id but the wrong fighter in f1. Fix by swapping.
  console.log('\n=== 0. Swap f1↔f2 where winner=f2 (convention fix) ===');
  {
    const { data: wins2026 } = await supabase.from('fights')
      .select('id,fighter1_id,fighter2_id,winner_id,events!inner(date)')
      .eq('result', 'win')
      .gte('events.date', '2026-01-01');
    const toFlip = (wins2026 || []).filter(f => f.winner_id && f.winner_id === f.fighter2_id);
    if (!toFlip.length) {
      console.log('  None found — all 2026 wins have f1 = winner. ✓');
    }
    for (const f of toFlip) {
      await patch(f.id, { fighter1_id: f.fighter2_id, fighter2_id: f.fighter1_id },
        `swap f1↔f2 (winner was f2, event ${f.events?.date})`);
    }
  }

  // ── 1. Justin Tafa → Junior Tafa ─────────────────────────────────────────────
  // The DB has two fighters: Justin Tafa and Junior Tafa.
  // Wikipedia uses "Junior Tafa" for all UFC appearances; Justin Tafa is a mismatch.
  console.log('\n=== 1. Justin Tafa → Junior Tafa ===');

  const junior = byName['juniortafa'];
  const justin = byName['justintafa'];

  if (!junior || !justin) {
    console.log('  Could not locate both Tafa fighters by name — printing candidates:');
    allFighters.filter(f => (f.last_name||'').toLowerCase() === 'tafa').forEach(f =>
      console.log(`    ${f.id.slice(0,8)} ${f.first_name} ${f.last_name}`)
    );
  } else {
    console.log(`  Junior Tafa: ${junior.id.slice(0,8)}   Justin Tafa: ${justin.id.slice(0,8)}`);

    // Find every fight that mentions Justin Tafa
    const chunks = [];
    for (let i = 0; i < 1; i++) { // only need to query both fighter slot columns
      const { data: asF1 } = await supabase.from('fights')
        .select('id,fighter1_id,fighter2_id,winner_id,events(name,date)')
        .eq('fighter1_id', justin.id);
      const { data: asF2 } = await supabase.from('fights')
        .select('id,fighter1_id,fighter2_id,winner_id,events(name,date)')
        .eq('fighter2_id', justin.id);
      chunks.push(...(asF1||[]), ...(asF2||[]));
    }

    if (!chunks.length) {
      console.log('  No fights found for Justin Tafa.');
    } else {
      for (const f of chunks) {
        const evName = f.events?.name || f.event_id;
        const evDate = f.events?.date || '';
        const fields = {};
        if (f.fighter1_id === justin.id) fields.fighter1_id = junior.id;
        if (f.fighter2_id === justin.id) fields.fighter2_id = junior.id;
        if (f.winner_id   === justin.id) fields.winner_id   = junior.id;
        await patch(f.id, fields, `Justin→Junior in "${evName}" (${evDate})`);
      }
    }
  }

  // ── 2. Method = fighter last name (data bug from API-Sports import) ───────────
  // Some fights have the fighter's last name stored as the method string.
  // Known cases from Muhammad vs Bonfim (June 6, 2026):
  //   Bryce Mitchell def. Santiago Luna  — method="Mitchell" → SUB, R3 4:52
  //   Alessandro Costa def. Matt Schnell  — method="Schnell" → KO/TKO, R1 2:28
  console.log('\n=== 2. Fix method=fighter-name ===');

  const { data: bonfimEv } = await supabase.from('events')
    .select('id,name')
    .ilike('name', '%Muhammad%Bonfim%')
    .single();

  if (!bonfimEv) {
    console.log('  Could not find Muhammad vs Bonfim event.');
  } else {
    const { data: bonfimFights } = await supabase.from('fights')
      .select('id,fighter1_id,fighter2_id,method,round,time')
      .eq('event_id', bonfimEv.id);

    for (const f of (bonfimFights || [])) {
      const method = (f.method || '').trim();
      if (!method) continue;

      // Check if method matches a fighter's last name
      const normMethod = norm(method);
      const f1last = norm(fById[f.fighter1_id]?.last_name || '');
      const f2last = norm(fById[f.fighter2_id]?.last_name || '');

      if (normMethod === f1last || normMethod === f2last) {
        const f1name = fname(f.fighter1_id);
        const f2name = fname(f.fighter2_id);
        let newMethod, newRound, newTime;

        if (normMethod === norm('Mitchell') || (f1last === 'mitchell' || f2last === 'mitchell')) {
          // Bryce Mitchell def. Santiago Luna by SUB (arm-triangle choke), R3 4:52
          newMethod = 'SUB'; newRound = 3; newTime = '4:52';
        } else if (normMethod === norm('Schnell') || (f1last === 'schnell' || f2last === 'schnell')) {
          // Alessandro Costa def. Matt Schnell by TKO (punches), R1 2:28
          newMethod = 'KO/TKO'; newRound = 1; newTime = '2:28';
        } else {
          console.log(`  UNKNOWN fighter-name method: "${method}" for ${f1name} vs ${f2name} (${f.id.slice(0,8)})`);
          continue;
        }

        const fields = { method: newMethod, round: newRound, time: newTime };
        await patch(f.id, fields, `"${method}"→${newMethod} (${f1name} vs ${f2name})`);
      }
    }
  }

  console.log('\nDone. Next steps:');
  console.log('  node -r dotenv/config src/scrapers/fix-fighter-records.js');
  console.log('  node src/validate.js');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
