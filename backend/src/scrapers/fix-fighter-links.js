/**
 * fix-fighter-links.js — import missing fights from API-Sports (2022-2026)
 * Usage: node src/scrapers/fix-fighter-links.js [--dry-run]
 */

require('dotenv').config();
const axios    = require('axios');
const supabase = require('../db/client');

const KEY  = process.env.API_SPORTS_KEY;
const BASE = process.env.API_SPORTS_BASE || 'https://v1.mma.api-sports.io';
const DRY  = process.argv.includes('--dry-run');

if (!KEY || KEY === 'your-api-sports-key') {
  console.error('ERROR: Set API_SPORTS_KEY in .env before running.');
  process.exit(1);
}

const api = axios.create({
  baseURL: BASE,
  timeout: 20000,
  headers: { 'x-apisports-key': KEY },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function loadAll(table, select) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data } = await supabase.from(table).select(select).range(offset, offset + 999);
    if (!data || !data.length) break;
    rows.push(...data);
    offset += 1000;
    if (data.length < 1000) break;
  }
  return rows;
}

async function main() {
  console.log('fix-fighter-links — import missing fights' + (DRY ? ' [DRY RUN]' : ''));

  // Check API quota
  const { data: st } = await api.get('/status');
  const { current, limit_day } = st.response.requests;
  const remaining = limit_day - current;
  console.log('API requests remaining today: ' + remaining + '/' + limit_day);
  if (remaining < 6) {
    console.error('Need 6+ requests (1 per season + overhead). Try again tomorrow.');
    process.exit(1);
  }

  // Load fighters
  console.log('\nLoading DB fighters...');
  const fighters = await loadAll('fighters', 'id, first_name, last_name');
  const byName = {};
  for (const f of fighters) {
    const full = norm((f.first_name || '') + (f.last_name || ''));
    const last = norm(f.last_name || '');
    if (full) byName[full] = f.id;
    if (last && !byName[last]) byName[last] = f.id;
  }
  console.log('  ' + fighters.length + ' fighters');

  // Load existing fight pairs to avoid duplicates
  const fightRefs = await loadAll('fights', 'event_id, fighter1_id, fighter2_id');
  const fightSet = new Set(fightRefs.map(f => f.event_id + ':' + f.fighter1_id + ':' + f.fighter2_id));
  console.log('  ' + fightRefs.length + ' existing fights');

  // Load events
  const events = await loadAll('events', 'id, name, date');
  const evByNorm = {};
  const evByDate = {};
  for (const ev of events) {
    evByNorm[norm(ev.name)] = ev;
    if (ev.date) {
      if (!evByDate[ev.date]) evByDate[ev.date] = [];
      evByDate[ev.date].push(ev);
    }
  }
  console.log('  ' + events.length + ' events');

  // Weight classes
  const { data: wcs } = await supabase.from('weight_classes').select('id, name');
  const wcByNorm = {};
  (wcs || []).forEach(w => { wcByNorm[norm(w.name)] = w.id; });
  function resolveWC(cat) {
    return wcByNorm[norm(cat)] || wcByNorm[norm(cat).replace('womens', 'womens')] || null;
  }

  let inserted = 0, skipped = 0, noEvent = 0, noFighter = 0;
  const SEASONS = [2022, 2023, 2024, 2025, 2026];

  for (const season of SEASONS) {
    await sleep(300);
    console.log('\nSeason ' + season + '...');

    let apiFights = [];
    try {
      const { data } = await api.get('/fights', { params: { season } });
      apiFights = data.response || [];
      console.log('  ' + apiFights.length + ' fights from API');
    } catch (e) {
      console.error('  Failed: ' + e.message);
      continue;
    }

    // Group fights by event (slug + date)
    const byEvent = {};
    for (const f of apiFights) {
      const key = f.slug + '|' + (f.date || '').slice(0, 10);
      if (!byEvent[key]) byEvent[key] = { slug: f.slug, date: (f.date || '').slice(0, 10), fights: [] };
      byEvent[key].fights.push(f);
    }
    console.log('  ' + Object.keys(byEvent).length + ' events');

    for (const { slug, date, fights: evFights } of Object.values(byEvent)) {
      let dbEvent = evByNorm[norm(slug)];
      if (!dbEvent && date && evByDate[date]) dbEvent = evByDate[date][0];
      if (!dbEvent) { noEvent += evFights.length; continue; }

      for (const af of evFights) {
        const f1Name = (af.fighters && af.fighters.first && af.fighters.first.name) || '';
        const f2Name = (af.fighters && af.fighters.second && af.fighters.second.name) || '';
        const f1Win  = af.fighters && af.fighters.first && af.fighters.first.winner === true;
        const f2Win  = af.fighters && af.fighters.second && af.fighters.second.winner === true;

        const f1Id = byName[norm(f1Name)];
        const f2Id = byName[norm(f2Name)];
        if (!f1Id || !f2Id) { noFighter++; continue; }

        const k1 = dbEvent.id + ':' + f1Id + ':' + f2Id;
        const k2 = dbEvent.id + ':' + f2Id + ':' + f1Id;
        if (fightSet.has(k1) || fightSet.has(k2)) { skipped++; continue; }

        const winnerId = f1Win ? f1Id : (f2Win ? f2Id : null);
        const isDraw   = !f1Win && !f2Win && af.status && af.status.short === 'FT';
        const result   = isDraw ? 'draw' : (winnerId ? 'win' : null);
        const wcId     = resolveWC(af.category || '');

        if (DRY) {
          console.log('  [DRY] ' + f1Name + ' vs ' + f2Name + ' @ ' + slug + ' (' + date + ')');
          inserted++;
          fightSet.add(k1);
          continue;
        }

        const { error } = await supabase.from('fights').insert({
          event_id: dbEvent.id,
          fighter1_id: f1Id,
          fighter2_id: f2Id,
          winner_id: winnerId,
          weight_class_id: wcId,
          result,
        });

        if (error) {
          if (!error.message.includes('duplicate')) console.error('  Insert: ' + error.message);
          skipped++;
        } else {
          inserted++;
          fightSet.add(k1);
        }
      }
    }
  }

  console.log('\n' + '='.repeat(46));
  console.log('Inserted:           ' + inserted);
  console.log('Already in DB:      ' + skipped);
  console.log('No DB event match:  ' + noEvent);
  console.log('Fighter not in DB:  ' + noFighter);
  console.log('='.repeat(46));

  if (inserted > 0 && !DRY) {
    console.log('\nAssigning card positions...');
    console.log('Now run: node src/scrapers/fix-card-position.js');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
