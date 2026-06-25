/**
 * Events + Fights scraper — API-Sports (v1.mma.api-sports.io)
 *
 * Replaces the ufcstats.com scraper (blocked by Cloudflare since June 2025).
 * Fetches UFC fights by season, groups by event slug, upserts events + fights.
 *
 * What the API provides:  winner, weight class, event name/date, fight status
 * What it does NOT have:  method (KO/SUB/DEC), round, time — existing values
 *   for those fields are preserved on updates and left null on new inserts.
 *
 * Flags:
 *   --season YEAR    Process only one season (default: all seasons 2022–current+1)
 *   --dry-run        Print changes without writing to DB
 *
 * Usage: node src/scrapers/events.js [--season YEAR] [--dry-run]
 */
require('dotenv').config();
const axios    = require('axios');
const supabase = require('../db/client');

const KEY = process.env.API_SPORTS_KEY;
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

function toSlug(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function fixEncoding(s) {
  if (!s) return s;
  try { return decodeURIComponent(escape(s)); } catch { return s; }
}

// norm(api_name) => norm(db_name)
// Handles encoding variants, nickname/middle-name differences, romanization variants
const NAME_MAP = {
  // Single-name fighters stored as first==last in DB; API sometimes sends space-separated form
  'rongzhu':            'rongzhurongzhu',
  'aoriqileng':         'aoriqilengaoriqileng',
  'alatengheili':       'alatengheilialatengheili',
  'yizha':              'yizhayizha',
  'sumudaerji':         'sumudaerjisumudaerji',
  'maheshate':          'maheshatemaheshate',
  'mizuki':             'mizukimizuki',
  // Middle name / extra name differences
  'iangarry':           'ianmachadogarry',
  'markomadsen':        'markmadsen',
  'josemigueldelgado':  'josedelgado',
  // Nickname vs registered name in ufcstats
  'bobbygreen':         'kinggreen',
  'charlieradtke':      'charlesradtke',
  'zachscroggin':       'zacharyscroggin',
  'billygoff':          'billyraygoff',
  'montserratrendon':   'montserendon',
  // Romanization variants
  'daunjung':           'dawoonjung',
  'baysangursusurkaev': 'baisangursusurkaev',
  // Spelling variants (API vs ufcstats)
  'assualmabayev':      'asualmabayev',
  'bernardosopaj':      'benardosopaj',
  'raffaelcerqueira':   'rafaelcerqueira',
  'zacharyreese':       'zachreese',
  'kleidisonrodrigues': 'kleydsonrodrigues',
  // Fighter changed name (married)
  'teciatorres':         'teciapennington',
  // Single-name (additional)
  'sulangrangbo':        'sulangrangbosulangrangbo',
};

function lookupFighter(rawName, byName) {
  if (!rawName || /^(opponent\s+)?tba$/i.test(rawName.trim())) return null;
  let id = byName[norm(rawName)];
  if (id) return id;
  const fixed = fixEncoding(rawName);
  if (fixed !== rawName) {
    id = byName[norm(fixed)];
    if (id) return id;
  }
  const n = norm(rawName);
  if (NAME_MAP[n]) { id = byName[NAME_MAP[n]]; if (id) return id; }
  const nf = norm(fixed);
  if (nf !== n && NAME_MAP[nf]) { id = byName[NAME_MAP[nf]]; if (id) return id; }
  return null;
}

function deriveCardPosition(boutOrder, total) {
  if (total <= 5)  return 'main_card';
  if (total <= 10) return boutOrder < 5 ? 'main_card' : 'prelim';
  if (total <= 14) {
    const earlyCount = total - 9;
    if (boutOrder < 5)                  return 'main_card';
    if (boutOrder < total - earlyCount) return 'prelim';
    return 'early_prelim';
  }
  if (boutOrder < 5)  return 'main_card';
  if (boutOrder < 11) return 'prelim';
  return 'early_prelim';
}

async function loadAll(table, select) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data } = await supabase.from(table).select(select).range(offset, offset + 999);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  UFCDB — Events + Fights (API-Sports)    ║');
  if (DRY) console.log('║  Mode: DRY RUN                           ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const { data: st } = await api.get('/status');
  const { current, limit_day } = st.response.requests;
  console.log(`API quota: ${current}/${limit_day} used  (${limit_day - current} remaining)\n`);

  // Fighter name → UUID
  console.log('Loading fighters...');
  const fighters = await loadAll('fighters', 'id, first_name, last_name');
  const fighterByName = {};
  for (const f of fighters) {
    const full    = norm((f.first_name || '') + ' ' + (f.last_name || ''));
    const compact = norm((f.first_name || '') + (f.last_name || ''));
    if (full)    fighterByName[full]    = f.id;
    if (compact) fighterByName[compact] = f.id;
  }
  console.log(`  ${fighters.length} fighters\n`);

  // Weight class name → id
  const { data: wcs } = await supabase.from('weight_classes').select('id, name');
  const wcByNorm = {};
  for (const wc of wcs || []) wcByNorm[norm(wc.name)] = wc.id;

  function resolveWC(category) {
    const n = norm(category);
    return wcByNorm[n] || null;
  }

  // Existing events: date → event row, norm(name) → event row
  console.log('Loading events...');
  const dbEvents = await loadAll('events', 'id, name, slug, date, is_complete');
  const evByDate = {};
  const evByNorm = {};
  for (const ev of dbEvents) {
    if (ev.date) evByDate[ev.date] = ev;
    evByNorm[norm(ev.name)] = ev;
  }
  console.log(`  ${dbEvents.length} events\n`);

  // Existing fights: "eventId:sortedF1:sortedF2" → fight row
  console.log('Loading fights...');
  const fightRefs = await loadAll('fights', 'id, event_id, fighter1_id, fighter2_id');
  const fightMap = {};
  for (const f of fightRefs) {
    const key = f.event_id + ':' + [f.fighter1_id, f.fighter2_id].sort().join(':');
    fightMap[key] = f;
  }
  console.log(`  ${fightRefs.length} fights\n`);

  // Determine seasons
  const seasonIdx  = process.argv.indexOf('--season');
  const singleYear = seasonIdx >= 0 ? parseInt(process.argv[seasonIdx + 1]) : null;
  const now        = new Date().getFullYear();
  const seasons    = singleYear
    ? [singleYear]
    : Array.from({ length: now - 2022 + 2 }, (_, i) => 2022 + i);
  console.log(`Seasons: ${seasons.join(', ')}\n`);

  let eventsInserted = 0, eventsUpdated = 0;
  let fightsInserted = 0, fightsUpdated = 0, noFighter = 0;
  const unmatched = new Set();

  for (const season of seasons) {
    await sleep(300);
    console.log(`── Season ${season} ${'─'.repeat(30)}`);

    let apiFights;
    try {
      const { data } = await api.get('/fights', { params: { season } });
      apiFights = data.response || [];
    } catch (e) {
      console.error(`  Failed: ${e.message}`);
      continue;
    }
    console.log(`  ${apiFights.length} fights from API`);

    // Group by slug; skip cancelled
    const groups = {};
    for (const f of apiFights) {
      if (f.status.short === 'CANC') continue;
      if (!groups[f.slug]) groups[f.slug] = [];
      groups[f.slug].push(f);
    }
    console.log(`  ${Object.keys(groups).length} events after removing cancelled`);

    for (const [slug, evFights] of Object.entries(groups)) {
      // Event date: prefer the is_main fight's date; else latest date in group
      const mainFight = evFights.find(f => f.is_main);
      const eventDate = mainFight
        ? mainFight.date.slice(0, 10)
        : evFights.map(f => f.date.slice(0, 10)).sort().pop();

      const isComplete = evFights.some(f => f.status.short === 'FT');

      // Find existing DB event by date first (check ±1 day for UTC vs local offset),
      // then fall back to normalized name match
      let dbEvent = evByDate[eventDate];
      if (!dbEvent) {
        const d = new Date(eventDate + 'T12:00:00Z');
        const prev = new Date(d); prev.setUTCDate(prev.getUTCDate() - 1);
        const next = new Date(d); next.setUTCDate(next.getUTCDate() + 1);
        dbEvent = evByDate[prev.toISOString().slice(0, 10)]
               || evByDate[next.toISOString().slice(0, 10)]
               || evByNorm[norm(slug)];
      }

      if (!dbEvent) {
        if (DRY) {
          console.log(`  [DRY] New event: "${slug}" (${eventDate})`);
          eventsInserted++;
          continue;
        }
        const payload = {
          name:        slug,
          slug:        toSlug(slug),
          date:        eventDate,
          is_complete: isComplete,
        };
        const { data: ins, error } = await supabase
          .from('events')
          .upsert(payload, { onConflict: 'slug' })
          .select('id, name, date, is_complete')
          .single();
        if (error || !ins) {
          console.error(`  Event insert failed "${slug}":`, error?.message);
          continue;
        }
        dbEvent = ins;
        evByDate[eventDate] = dbEvent;
        evByNorm[norm(slug)] = dbEvent;
        eventsInserted++;
        console.log(`  + Event: "${slug}" (${eventDate})`);
      } else if (!dbEvent.is_complete && isComplete) {
        if (!DRY) {
          await supabase.from('events').update({ is_complete: true }).eq('id', dbEvent.id);
        }
        dbEvent.is_complete = true;
        eventsUpdated++;
      }

      // Sort: main event first (bout_order 0), then remaining in API order
      const sorted = [
        ...evFights.filter(f =>  f.is_main),
        ...evFights.filter(f => !f.is_main),
      ];
      const total = sorted.length;

      for (let i = 0; i < sorted.length; i++) {
        const af    = sorted[i];
        const f1raw = af.fighters?.first?.name  || '';
        const f2raw = af.fighters?.second?.name || '';
        const f1Win = af.fighters?.first?.winner  === true;
        const f2Win = af.fighters?.second?.winner === true;

        const f1Id = lookupFighter(f1raw, fighterByName);
        const f2Id = lookupFighter(f2raw, fighterByName);
        if (!f1Id || !f2Id) {
          noFighter++;
          if (!f1Id && f1raw && !/^(opponent\s+)?tba$/i.test(f1raw.trim())) unmatched.add(f1raw);
          if (!f2Id && f2raw && !/^(opponent\s+)?tba$/i.test(f2raw.trim())) unmatched.add(f2raw);
          continue;
        }

        const winnerId  = f1Win ? f1Id : (f2Win ? f2Id : null);
        const result    = af.status.short === 'FT'
          ? (winnerId ? 'win' : 'draw')
          : 'upcoming';
        const wcId      = resolveWC(af.category);
        const boutOrder = i;
        const cardPos   = deriveCardPosition(boutOrder, total);
        const fightKey  = dbEvent.id + ':' + [f1Id, f2Id].sort().join(':');
        const existing  = fightMap[fightKey];

        if (existing) {
          if (!DRY) {
            await supabase.from('fights').update({
              winner_id:       winnerId,
              result,
              weight_class_id: wcId,
            }).eq('id', existing.id);
          }
          fightsUpdated++;
        } else {
          if (!DRY) {
            const { error } = await supabase.from('fights').insert({
              event_id:        dbEvent.id,
              fighter1_id:     f1Id,
              fighter2_id:     f2Id,
              winner_id:       winnerId,
              result,
              weight_class_id: wcId,
              is_title_fight:  false,
              bout_order:      boutOrder,
              card_position:   cardPos,
            });
            if (error && !error.message?.includes('duplicate')) {
              console.error(`  Fight insert error (${slug}):`, error.message);
              continue;
            }
          }
          fightsInserted++;
          fightMap[fightKey] = { id: 'pending' };
        }
      }
    }
  }

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  Complete!                               ║');
  console.log(`║  Events inserted: ${String(eventsInserted).padEnd(22)}║`);
  console.log(`║  Events updated:  ${String(eventsUpdated).padEnd(22)}║`);
  console.log(`║  Fights inserted: ${String(fightsInserted).padEnd(22)}║`);
  console.log(`║  Fights updated:  ${String(fightsUpdated).padEnd(22)}║`);
  console.log(`║  Fighter no-match:${String(noFighter).padEnd(22)}║`);
  console.log('╚══════════════════════════════════════════╝');
  if (unmatched.size) {
    console.log('');
    console.log('Unmatched fighter names (' + unmatched.size + '):');
    for (const n of [...unmatched].sort()) console.log('  ' + n);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
