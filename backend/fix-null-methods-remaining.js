/**
 * fix-null-methods-remaining.js
 *
 * Patches the 7 remaining null-method fights that fix-fight-methods.js could not
 * resolve automatically due to name mismatches or missing Wikipedia pages.
 *
 * Two of these fights also have wrong fighter1/winner convention and are corrected:
 *   - Vergara vs Lacerda: DB had Lacerda as f1, but Vergara won
 *   - Katona vs Valiev: DB had Valiev as f1, but Katona won
 *
 * Source: UFC.com athlete pages + Wikipedia TUF 31 tournament bracket
 *
 * Run: node -r dotenv/config fix-null-methods-remaining.js [--dry-run]
 */
require('dotenv').config();
const supabase = require('./src/db/client');

const DRY = process.argv.includes('--dry-run');

const norm = s => (s || '').toLowerCase()
  .replace(/[łŁ]/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

async function main() {
  console.log(DRY ? '=== DRY RUN ===' : '=== APPLYING FIXES ===');

  // Load fighters
  const allFighters = [];
  let page = 0;
  while (true) {
    const { data } = await supabase.from('fighters').select('id,first_name,last_name')
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!data?.length) break;
    allFighters.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  const byNorm = {};
  allFighters.forEach(f => { byNorm[norm((f.first_name || '') + (f.last_name || ''))] = f; });
  const byId = Object.fromEntries(allFighters.map(f => [f.id, f]));
  const fname = id => { const f = byId[id]; return f ? `${f.first_name} ${f.last_name}` : id?.slice(0, 8); };

  // Helper: find a fight by event name fragment + two last names
  async function findFight(evFrag, last1, last2) {
    const { data: evs } = await supabase.from('events').select('id,name,date')
      .ilike('name', '%' + evFrag + '%');
    if (!evs?.length) { console.log('  SKIP event not found: ' + evFrag); return null; }

    for (const ev of evs) {
      const { data: fights } = await supabase.from('fights')
        .select('id,fighter1_id,fighter2_id,winner_id,result,method,round,time')
        .eq('event_id', ev.id);

      for (const f of (fights || [])) {
        const l1 = byId[f.fighter1_id]?.last_name?.toLowerCase() || '';
        const l2 = byId[f.fighter2_id]?.last_name?.toLowerCase() || '';
        if (
          ([l1, l2].includes(last1.toLowerCase()) && [l1, l2].includes(last2.toLowerCase()))
        ) {
          return { fight: f, event: ev };
        }
      }
    }
    return null;
  }

  async function patchFight(fightId, fields, label) {
    if (DRY) {
      console.log('  DRY ' + fightId.slice(0, 8) + ' ' + label + ' → ' + JSON.stringify(fields));
      return;
    }
    const { error } = await supabase.from('fights').update(fields).eq('id', fightId);
    if (error) console.error('  ERR ' + fightId.slice(0, 8) + ' ' + label + ': ' + error.message);
    else console.log('  OK  ' + fightId.slice(0, 8) + ' ' + label);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. CJ Vergara def. Daniel Lacerda — TKO (strikes), R2, 4:04
  //    Source: UFC.com Vergara profile + UFC on ESPN: Vera vs. Sandhagen results
  //    DB bug: fighter1=Lacerda (wrong), should be fighter1=Vergara (the winner)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 1. Vergara def. Lacerda (fix winner + method) ---');
  {
    const r = await findFight('Vera vs. Sandhagen', 'Vergara', 'Lacerda');
    if (!r) {
      console.log('  SKIP not found');
    } else {
      const { fight: f, event: ev } = r;
      const vergara = byNorm['cjvergara'] || allFighters.find(x => x.last_name?.toLowerCase() === 'vergara' && x.first_name?.toLowerCase().includes('c'));
      const lacerda = byNorm['daniellacerda'] || allFighters.find(x => x.last_name?.toLowerCase() === 'lacerda' && x.first_name?.toLowerCase() === 'daniel');

      if (!vergara || !lacerda) { console.log('  SKIP could not find both fighters'); }
      else if (f.method) { console.log('  SKIP already has method: ' + f.method); }
      else {
        const label = `Vergara def. Lacerda @ ${ev.name} (${ev.date})`;
        await patchFight(f.id, {
          fighter1_id: vergara.id,
          fighter2_id: lacerda.id,
          winner_id: vergara.id,
          method: 'KO/TKO',
          method_detail: 'Punches',
          round: 2,
          time: '4:04',
        }, label);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Cody Gibson def. Rico DiSciullo — SUB (arm triangle choke), R1, 4:32
  //    Source: UFC.com Gibson profile
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Gibson def. DiSciullo (TUF 31 SF) ---');
  {
    const r = await findFight('Ultimate Fighter 31', 'Gibson', 'DiSciullo');
    if (!r) {
      console.log('  SKIP not found');
    } else {
      const { fight: f, event: ev } = r;
      if (f.method) { console.log('  ALREADY HAS method: ' + f.method + ' @ ' + ev.name); }
      else {
        await patchFight(f.id, {
          method: 'SUB',
          method_detail: 'Arm triangle choke',
          round: 1,
          time: '4:32',
        }, `Gibson def. DiSciullo @ ${ev.name}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Brad Katona def. Timur Valiev — S-DEC, R3, 5:00
  //    Source: UFC.com Katona profile + Wikipedia TUF 31 bracket
  //    DB bug: fighter1=Valiev (wrong), should be fighter1=Katona (the winner)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 3. Katona def. Valiev (TUF 31 SF, fix winner + method) ---');
  {
    const r = await findFight('Ultimate Fighter 31', 'Katona', 'Valiev');
    if (!r) {
      console.log('  SKIP not found');
    } else {
      const { fight: f, event: ev } = r;
      const katona = allFighters.find(x => x.last_name?.toLowerCase() === 'katona' && x.first_name?.toLowerCase().includes('brad'));
      const valiev = allFighters.find(x => x.last_name?.toLowerCase() === 'valiev' && x.first_name?.toLowerCase().includes('timur'));

      if (!katona || !valiev) { console.log('  SKIP could not find both fighters'); }
      else if (f.method) { console.log('  ALREADY HAS method: ' + f.method); }
      else {
        const label = `Katona def. Valiev @ ${ev.name} (${ev.date})`;
        await patchFight(f.id, {
          fighter1_id: katona.id,
          fighter2_id: valiev.id,
          winner_id: katona.id,
          method: 'S-DEC',
          round: 3,
          time: '5:00',
        }, label);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Austin Hubbard def. Roosevelt Roberts — S-DEC, R3, 5:00
  //    Source: UFC.com Hubbard profile
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 4. Hubbard def. Roberts (TUF 31 SF) ---');
  {
    const r = await findFight('Ultimate Fighter 31', 'Hubbard', 'Roberts');
    if (!r) {
      console.log('  SKIP not found');
    } else {
      const { fight: f, event: ev } = r;
      if (f.method) { console.log('  ALREADY HAS method: ' + f.method); }
      else {
        await patchFight(f.id, {
          method: 'S-DEC',
          round: 3,
          time: '5:00',
        }, `Hubbard def. Roberts @ ${ev.name}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Kurt Holobaugh def. Jason Knight — KO/TKO (strikes), R2, 2:56
  //    Source: UFC.com Holobaugh profile
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 5. Holobaugh def. Knight (TUF 31 SF) ---');
  {
    const r = await findFight('Ultimate Fighter 31', 'Holobaugh', 'Knight');
    if (!r) {
      console.log('  SKIP not found');
    } else {
      const { fight: f, event: ev } = r;
      if (f.method) { console.log('  ALREADY HAS method: ' + f.method); }
      else {
        await patchFight(f.id, {
          method: 'KO/TKO',
          method_detail: 'Strikes',
          round: 2,
          time: '2:56',
        }, `Holobaugh def. Knight @ ${ev.name}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Kevin Vallejos def. Choi Seung-woo — KO/TKO (punches), R1, 3:09
  //    Source: Wikipedia UFC Fight Night: Vettori vs. Dolidze 2
  //    Mismatch: Wikipedia "Choi Seung-woo" vs DB "SeungWoo Choi" (Korean name order)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 6. Vallejos def. Choi (Vettori vs Dolidze 2) ---');
  {
    const r = await findFight('Vettori vs. Dolidze 2', 'Vallejos', 'Choi');
    if (!r) {
      // Try alternate last name
      const r2 = await findFight('Vettori vs. Dolidze', 'Vallejos', 'Choi');
      if (!r2) { console.log('  SKIP not found'); }
      else {
        const { fight: f, event: ev } = r2;
        if (f.method) { console.log('  ALREADY HAS method: ' + f.method); }
        else {
          await patchFight(f.id, { method: 'KO/TKO', method_detail: 'Punches', round: 1, time: '3:09' },
            `Vallejos def. Choi @ ${ev.name}`);
        }
      }
    } else {
      const { fight: f, event: ev } = r;
      if (f.method) { console.log('  ALREADY HAS method: ' + f.method); }
      else {
        await patchFight(f.id, { method: 'KO/TKO', method_detail: 'Punches', round: 1, time: '3:09' },
          `Vallejos def. Choi @ ${ev.name}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Ketlen Vieira def. Macy Chiasson — U-DEC, R3, 5:00
  //    Source: Wikipedia UFC on ESPN: Gamrot vs. Klein (same event, different DB name)
  //    Mismatch: DB "Blanchfield vs. Barber", Wikipedia "Gamrot vs. Klein"
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 7. Vieira def. Chiasson (Blanchfield vs Barber / Gamrot vs Klein event) ---');
  {
    const r = await findFight('Blanchfield vs. Barber', 'Vieira', 'Chiasson');
    if (!r) { console.log('  SKIP not found'); }
    else {
      const { fight: f, event: ev } = r;
      if (f.method) { console.log('  ALREADY HAS method: ' + f.method); }
      else {
        await patchFight(f.id, { method: 'U-DEC', round: 3, time: '5:00' },
          `Vieira def. Chiasson @ ${ev.name}`);
      }
    }
  }

  console.log('\nDone.' + (DRY ? ' (dry run)' : ''));
  console.log('Run next: node src/validate.js && node -r dotenv/config src/scrapers/fix-fighter-records.js');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
